-- =============================================================================
-- Portal de Projetos YouCon — Migration 0011 (Etapa 3): ações que removem
-- registros (dependência manual, etapas de rascunho de template, rascunho
-- descartado). Separadas para revisão: só apagam dependências de etapa ou
-- conteúdo de templates em RASCUNHO; versões publicadas são imutáveis.
-- =============================================================================

create or replace function private.remove_task_dependency(p_task uuid, p_depends_on uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  v_ids uuid[];
begin
  t := private.task_for_edit(p_task, true);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Informe o motivo da remoção da dependência' using errcode = '23514';
  end if;
  perform private.engine_on();
  delete from public.task_dependencies where task_id = t.id and depends_on_task_id = p_depends_on;
  if not found then raise exception 'Dependência não encontrada' using errcode = 'P0002'; end if;
  v_ids := private.apply_schedule(t.project_id);
  insert into public.task_changes (project_id, task_id, change_type, before, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, 'dependency', jsonb_build_object('removed', p_depends_on), trim(p_reason), v_ids, private.current_profile_id());
  return jsonb_build_object('impacted_count', coalesce(array_length(v_ids, 1), 0));
end;
$$;

-- Salva o rascunho inteiro. p_tasks em ordem:
-- [{"id": uuid|null, "name": "...", "description": "...", "duration_days": n|null,
--   "duration_type": "fixed|dependent|external|ongoing", "include_if": ["code"]|null,
--   "client_visible": true, "cross_deps": [{"service_code": "...", "task_code": "..."}]}]
-- Cada etapa depende da anterior (sequência). Dependências entre serviços pelo código.
create or replace function private.save_template_draft(p_template uuid, p_name text, p_tasks jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  tpl public.schedule_templates;
  x jsonb;
  i int := 0;
  v_id uuid;
  v_prev uuid;
  v_code text;
  v_type public.duration_type;
  v_days int;
  v_keep uuid[];
  dep jsonb;
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  select * into tpl from public.schedule_templates where id = p_template for update;
  if tpl.id is null then raise exception 'Template não encontrado' using errcode = 'P0002'; end if;
  if tpl.status <> 'draft' then
    raise exception 'Template publicado é imutável. Crie uma nova versão para alterar o padrão YouCon.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_tasks) <> 'array' or jsonb_array_length(p_tasks) = 0 then
    raise exception 'O template precisa de ao menos uma etapa' using errcode = '23514';
  end if;

  v_keep := array(select (e ->> 'id')::uuid from jsonb_array_elements(p_tasks) e where nullif(e ->> 'id', '') is not null);

  delete from public.template_task_dependencies d using public.template_tasks tt
   where tt.id = d.template_task_id and tt.template_id = tpl.id;
  delete from public.template_tasks where template_id = tpl.id and not (id = any (v_keep));

  update public.schedule_templates set name = coalesce(nullif(trim(p_name), ''), name) where id = tpl.id;

  for x in select * from jsonb_array_elements(p_tasks) loop
    i := i + 1;
    if length(trim(coalesce(x ->> 'name', ''))) = 0 then
      raise exception 'A etapa % está sem nome', i using errcode = '23514';
    end if;
    v_type := coalesce(nullif(x ->> 'duration_type', ''), 'fixed')::public.duration_type;
    v_days := nullif(x ->> 'duration_days', '')::int;
    if v_type <> 'fixed' then v_days := null; end if;
    if v_days is not null and (v_days < 1 or v_days > 2000) then
      raise exception 'Duração da etapa "%" deve ser de 1 a 2000 dias úteis', x ->> 'name' using errcode = '23514';
    end if;

    v_id := nullif(x ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from public.template_tasks where id = v_id and template_id = tpl.id) then
      update public.template_tasks set
        name = trim(x ->> 'name'), description = nullif(trim(coalesce(x ->> 'description', '')), ''),
        sort_order = i * 10, default_duration_days = v_days, duration_type = v_type,
        include_if_service_codes = case when jsonb_typeof(x -> 'include_if') = 'array' and jsonb_array_length(x -> 'include_if') > 0
                                        then array(select jsonb_array_elements_text(x -> 'include_if')) end,
        client_visible = coalesce((x ->> 'client_visible')::boolean, true), active = true
      where id = v_id;
    else
      v_code := nullif(private.slug(x ->> 'name'), '');
      v_code := coalesce(v_code, 'etapa');
      while exists (select 1 from public.template_tasks where template_id = tpl.id and code = v_code) loop
        v_code := v_code || '_' || i;
      end loop;
      insert into public.template_tasks (template_id, code, name, description, sort_order, default_duration_days, duration_type,
                                         include_if_service_codes, client_visible)
      values (tpl.id, v_code, trim(x ->> 'name'), nullif(trim(coalesce(x ->> 'description', '')), ''), i * 10, v_days, v_type,
              case when jsonb_typeof(x -> 'include_if') = 'array' and jsonb_array_length(x -> 'include_if') > 0
                   then array(select jsonb_array_elements_text(x -> 'include_if')) end,
              coalesce((x ->> 'client_visible')::boolean, true))
      returning id into v_id;
    end if;

    if v_prev is not null then
      insert into public.template_task_dependencies (template_task_id, predecessor_task_id) values (v_id, v_prev);
    end if;
    for dep in select * from jsonb_array_elements(coalesce(x -> 'cross_deps', '[]'::jsonb)) loop
      if not exists (select 1 from public.services where code = dep ->> 'service_code') then
        raise exception 'Serviço da dependência não existe: %', dep ->> 'service_code' using errcode = '23514';
      end if;
      if (select code from public.services where id = tpl.service_id) = dep ->> 'service_code' then
        raise exception 'Use a sequência para dependências dentro do mesmo serviço' using errcode = '23514';
      end if;
      insert into public.template_task_dependencies (template_task_id, predecessor_service_code, predecessor_task_code, optional_if_missing)
      values (v_id, dep ->> 'service_code', dep ->> 'task_code', true);
    end loop;
    if v_type = 'dependent' and jsonb_array_length(coalesce(x -> 'cross_deps', '[]'::jsonb)) = 0 then
      raise exception 'A etapa "%" é do tipo dependente: indique de qual etapa de outro serviço ela depende', x ->> 'name'
        using errcode = '23514';
    end if;
    v_prev := v_id;
  end loop;
end;
$$;

create or replace function private.discard_template_draft(p_template uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  delete from public.schedule_templates where id = p_template and status = 'draft';
  if not found then raise exception 'Rascunho não encontrado' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.remove_task_dependency(p_task uuid, p_depends_on uuid, p_reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.remove_task_dependency(p_task, p_depends_on, p_reason) $$;

create or replace function public.save_template_draft(p_template uuid, p_name text, p_tasks jsonb) returns void
language sql security invoker set search_path = '' as $$ select private.save_template_draft(p_template, p_name, p_tasks) $$;

create or replace function public.discard_template_draft(p_template uuid) returns void
language sql security invoker set search_path = '' as $$ select private.discard_template_draft(p_template) $$;

revoke all on function public.remove_task_dependency(uuid, uuid, text), public.save_template_draft(uuid, text, jsonb),
                       public.discard_template_draft(uuid) from public, anon;
grant execute on function public.remove_task_dependency(uuid, uuid, text), public.save_template_draft(uuid, text, jsonb),
                          public.discard_template_draft(uuid) to authenticated;
revoke all on function private.remove_task_dependency(uuid, uuid, text), private.save_template_draft(uuid, text, jsonb),
                       private.discard_template_draft(uuid) from public, anon;
grant execute on function private.remove_task_dependency(uuid, uuid, text), private.save_template_draft(uuid, text, jsonb),
                          private.discard_template_draft(uuid) to authenticated, service_role;
