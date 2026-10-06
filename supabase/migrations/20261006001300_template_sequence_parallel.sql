-- =============================================================================
-- Portal de Projetos YouCon — Migration 0013 (Etapa 3): sequência e etapas
-- simultâneas nos padrões YouCon + ordem da biblioteca de etapas.
--
--   * Cada etapa do padrão pode ser "simultânea à anterior": etapas do mesmo
--     grupo começam juntas, e o grupo seguinte espera todas terminarem.
--   * Rascunhos guardam histórico: etapas e ligações retiradas ficam
--     desativadas (não são apagadas); rascunho descartado fica arquivado.
--   * Biblioteca de etapas com ordem definida pela operação (arrastar).
-- =============================================================================

alter table public.template_task_dependencies add column active boolean not null default true;

alter table public.task_library add column sort_order int;
update public.task_library l set sort_order = x.rn * 10
from (select id, row_number() over (order by lower(name)) as rn from public.task_library) x
where x.id = l.id;

-- -----------------------------------------------------------------------------
-- Rascunho: salvar com sequência e grupos simultâneos.
-- p_tasks (em ordem): [{"id", "name", "description", "duration_days", "duration_type",
--   "include_if", "client_visible", "parallel": true|false, "cross_deps": [{service_code, task_code}]}]
-- "parallel" = simultânea à etapa anterior (mesmo grupo).
-- -----------------------------------------------------------------------------
create or replace function private.save_template_draft(p_template uuid, p_name text, p_tasks jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  tpl public.schedule_templates;
  x jsonb;
  i int := 0;
  v_id uuid;
  v_code text;
  v_type public.duration_type;
  v_days int;
  v_keep uuid[];
  v_prev_group uuid[] := '{}';
  v_group uuid[] := '{}';
  v_pred uuid;
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

  -- Ligações e etapas retiradas ficam desativadas (histórico do rascunho).
  update public.template_task_dependencies d set active = false
    from public.template_tasks tt
   where tt.id = d.template_task_id and tt.template_id = tpl.id and d.active;
  update public.template_tasks set active = false
   where template_id = tpl.id and active and not (id = any (v_keep));

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

    -- Novo grupo quando a etapa não é simultânea à anterior.
    if i > 1 and not coalesce((x ->> 'parallel')::boolean, false) then
      v_prev_group := v_group;
      v_group := '{}';
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
      v_code := coalesce(nullif(private.slug(x ->> 'name'), ''), 'etapa');
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

    -- Espera todas as etapas do grupo anterior.
    foreach v_pred in array v_prev_group loop
      insert into public.template_task_dependencies (template_task_id, predecessor_task_id) values (v_id, v_pred);
    end loop;
    v_group := v_group || v_id;

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
  end loop;
end;
$$;

-- Rascunho descartado fica arquivado (sem publicação), fora da lista de versões.
create or replace function private.discard_template_draft(p_template uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  update public.schedule_templates set status = 'archived', active = false, notes = 'Rascunho descartado'
   where id = p_template and status = 'draft';
  if not found then raise exception 'Rascunho não encontrado' using errcode = 'P0002'; end if;
end;
$$;

-- Ordem da biblioteca (arrastar). Gestores organizam.
create or replace function private.reorder_task_library(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager() then
    raise exception 'Somente gestores organizam a biblioteca de etapas' using errcode = '42501';
  end if;
  update public.task_library l set sort_order = x.ord * 10
  from unnest(p_ids) with ordinality as x(id, ord)
  where l.id = x.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Motor: só ligações ativas do template contam (mesma lógica, com o filtro).
-- -----------------------------------------------------------------------------
create or replace function private.generate_schedule(p_project uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  cal uuid;
  v_base date;
  v_codes text[];
  ps record;
  tr public.project_schedule_tracks;
  pick record;
  v_tracks int := 0;
  v_tasks int := 0;
  v_n int;
  v_pending int;
  v_ids uuid[];
begin
  select * into p from public.projects where id = p_project;
  if p.id is null then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  perform private.engine_on();

  cal    := private.calendar_for_tenant(p.delivery_tenant_id);
  v_base := public.next_business_day(greatest(coalesce(p.started_at::date, current_date), current_date), cal);
  v_codes := array(select s.code from public.project_services x join public.services s on s.id = x.service_id
                   where x.project_id = p.id and x.active and x.status in ('active', 'completed'));

  for ps in
    select x.id, x.service_id, x.responsible_user_id from public.project_services x
    where x.project_id = p.id and x.active and x.status = 'active'
    order by x.created_at
  loop
    select * into tr from public.project_schedule_tracks where project_service_id = ps.id;
    if tr.id is not null and (tr.status not in ('no_template', 'awaiting_area')
                              or exists (select 1 from public.project_tasks where schedule_track_id = tr.id)) then
      continue;
    end if;

    select * into pick from private.pick_template(ps.service_id, p.client_type, p.area_m2);

    if tr.id is null then
      insert into public.project_schedule_tracks (project_id, project_service_id, template_id, status, base_date, status_note)
      values (p.id, ps.id, pick.template_id, pick.track_status, v_base, pick.note)
      returning * into tr;
      v_tracks := v_tracks + 1;
    else
      update public.project_schedule_tracks
         set template_id = pick.template_id, status = pick.track_status, status_note = pick.note, base_date = v_base
       where id = tr.id
      returning * into tr;
    end if;

    if pick.template_id is null then continue; end if;

    insert into public.project_tasks (schedule_track_id, project_id, template_task_id, code, name, description, sequence,
                                      duration_type, planned_duration_days, client_visible, status, responsible_user_id)
    select tr.id, p.id, tt.id, tt.code, tt.name, tt.description, tt.sort_order,
           tt.duration_type, tt.default_duration_days, tt.client_visible, 'not_started', ps.responsible_user_id
    from public.template_tasks tt
    where tt.template_id = pick.template_id and tt.active
      and (tt.include_if_service_codes is null or tt.include_if_service_codes && v_codes);
    get diagnostics v_n = row_count;
    v_tasks := v_tasks + v_n;

    insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, lag_days, source)
    with recursive inc as (
      select pt.template_task_id as id from public.project_tasks pt where pt.schedule_track_id = tr.id
    ),
    chain(task_tt, pred_tt, dtype, lag) as (
      select d.template_task_id, d.predecessor_task_id, d.dependency_type, d.lag_days
      from public.template_task_dependencies d
      where d.active and d.predecessor_task_id is not null and d.template_task_id in (select id from inc)
      union
      select c.task_tt, d.predecessor_task_id, 'finish_to_start'::public.dependency_type, 0
      from chain c
      join public.template_task_dependencies d on d.template_task_id = c.pred_tt
      where d.active and c.pred_tt not in (select id from inc) and d.predecessor_task_id is not null
    )
    select distinct on (a.id, b.id) a.id, b.id, c.dtype, c.lag, 'template'
    from chain c
    join public.project_tasks a on a.schedule_track_id = tr.id and a.template_task_id = c.task_tt
    join public.project_tasks b on b.schedule_track_id = tr.id and b.template_task_id = c.pred_tt
    on conflict (task_id, depends_on_task_id) do nothing;
  end loop;

  perform private.link_cross_dependencies(p.id);
  v_ids := private.apply_schedule(p.id);

  select count(*) into v_pending from public.project_schedule_tracks
  where project_id = p.id and status in ('no_template', 'awaiting_area');

  if v_tracks > 0 or v_tasks > 0 then
    insert into public.task_changes (project_id, change_type, after, reason, impacted_task_ids, changed_by)
    values (p.id, 'created', jsonb_build_object('tracks', v_tracks, 'tasks', v_tasks),
            coalesce(p_reason, 'Cronograma gerado'), v_ids, private.current_profile_id());
  end if;

  return jsonb_build_object('tracks_created', v_tracks, 'tasks_created', v_tasks, 'tracks_pending', v_pending);
end;
$$;

create or replace function private.link_cross_dependencies(p_project uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.engine_on();

  insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, lag_days, source)
  select distinct on (a.id, b.id) a.id, b.id, d.dependency_type, d.lag_days, 'template'
  from public.project_tasks a
  join public.template_task_dependencies d on d.template_task_id = a.template_task_id and d.active and d.predecessor_service_code is not null
  join public.services s on s.code = d.predecessor_service_code
  join public.project_services ps on ps.project_id = a.project_id and ps.service_id = s.id and ps.active
  join public.project_schedule_tracks tr on tr.project_service_id = ps.id
  join public.project_tasks b on b.schedule_track_id = tr.id and b.code = d.predecessor_task_code
  where a.project_id = p_project and a.status <> 'completed' and a.id <> b.id
  on conflict (task_id, depends_on_task_id) do nothing;

  -- "Tempo de produção da Arquitetura" sem Arquitetura contratada: etapa dispensada.
  update public.project_tasks t
     set status = 'cancelled', auto_skipped = true,
         waiting_reason = 'Dispensada: serviço predecessor não contratado'
   where t.project_id = p_project and t.duration_type = 'dependent' and t.actual_start_date is null
     and t.status in ('not_started', 'ready')
     and not exists (select 1 from public.task_dependencies d
                     join public.project_tasks p2 on p2.id = d.depends_on_task_id
                     where d.task_id = t.id and p2.schedule_track_id <> t.schedule_track_id);

  update public.project_tasks t
     set status = 'not_started', auto_skipped = false, waiting_reason = null
   where t.project_id = p_project and t.auto_skipped and t.status = 'cancelled'
     and exists (select 1 from public.task_dependencies d
                 join public.project_tasks p2 on p2.id = d.depends_on_task_id
                 where d.task_id = t.id and p2.schedule_track_id <> t.schedule_track_id);
end;
$$;

create or replace function private.create_template_draft(
  p_service uuid, p_from uuid default null, p_client_type public.client_type default null,
  p_area_min numeric default null, p_area_max numeric default null, p_name text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  src public.schedule_templates;
  s public.services;
  v_id uuid := gen_random_uuid();
  v_ct public.client_type := p_client_type;
  v_min numeric := p_area_min;
  v_max numeric := p_area_max;
  v_version int;
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  if p_from is not null then
    select * into src from public.schedule_templates where id = p_from;
    if src.id is null then raise exception 'Template não encontrado' using errcode = 'P0002'; end if;
    p_service := src.service_id; v_ct := src.client_type; v_min := src.area_min; v_max := src.area_max;
  end if;
  select * into s from public.services where id = p_service;
  if s.id is null then raise exception 'Serviço não encontrado' using errcode = 'P0002'; end if;
  if v_min is not null and v_max is not null and v_min >= v_max then
    raise exception 'A área mínima deve ser menor que a máxima' using errcode = '23514';
  end if;
  if exists (select 1 from public.schedule_templates t
             where t.service_id = p_service and t.status = 'draft' and t.client_type is not distinct from v_ct
               and t.area_min is not distinct from v_min and t.area_max is not distinct from v_max) then
    raise exception 'Já existe um rascunho desta variante. Continue editando ou descarte-o.' using errcode = '23505';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.schedule_templates t
  where t.service_id = p_service and t.client_type is not distinct from v_ct
    and t.area_min is not distinct from v_min and t.area_max is not distinct from v_max;

  insert into public.schedule_templates (id, service_id, name, version, client_type, area_min, area_max, status, active, created_by)
  values (v_id, p_service, coalesce(nullif(trim(p_name), ''), src.name, s.name), v_version, v_ct, v_min, v_max,
          'draft', false, private.current_profile_id());

  if src.id is not null then
    insert into public.template_tasks (template_id, code, name, description, sort_order, default_duration_days, duration_type,
                                       include_if_service_codes, client_visible, active)
    select v_id, code, name, description, sort_order, default_duration_days, duration_type, include_if_service_codes, client_visible, active
    from public.template_tasks where template_id = src.id and active;

    insert into public.template_task_dependencies (template_task_id, predecessor_task_id, predecessor_service_code,
                                                   predecessor_task_code, dependency_type, lag_days, optional_if_missing)
    select nt.id, np.id, d.predecessor_service_code, d.predecessor_task_code, d.dependency_type, d.lag_days, d.optional_if_missing
    from public.template_task_dependencies d
    join public.template_tasks ot on ot.id = d.template_task_id and ot.template_id = src.id
    join public.template_tasks nt on nt.template_id = v_id and nt.code = ot.code
    left join public.template_tasks op on op.id = d.predecessor_task_id
    left join public.template_tasks np on np.template_id = v_id and np.code = op.code
    where d.active and (d.predecessor_task_id is null or np.id is not null);
  end if;

  return v_id;
end;
$$;

create or replace function public.save_template_draft(p_template uuid, p_name text, p_tasks jsonb) returns void
language sql security invoker set search_path = '' as $$ select private.save_template_draft(p_template, p_name, p_tasks) $$;
create or replace function public.discard_template_draft(p_template uuid) returns void
language sql security invoker set search_path = '' as $$ select private.discard_template_draft(p_template) $$;
create or replace function public.reorder_task_library(p_ids uuid[]) returns void
language sql security invoker set search_path = '' as $$ select private.reorder_task_library(p_ids) $$;

revoke all on function public.save_template_draft(uuid, text, jsonb), public.discard_template_draft(uuid),
                       public.reorder_task_library(uuid[]) from public, anon;
grant execute on function public.save_template_draft(uuid, text, jsonb), public.discard_template_draft(uuid),
                          public.reorder_task_library(uuid[]) to authenticated;
revoke all on function private.save_template_draft(uuid, text, jsonb), private.discard_template_draft(uuid),
                       private.reorder_task_library(uuid[]) from public, anon;
grant execute on function private.save_template_draft(uuid, text, jsonb), private.discard_template_draft(uuid),
                          private.reorder_task_library(uuid[]) to authenticated, service_role;
revoke execute on function private.generate_schedule(uuid, text), private.link_cross_dependencies(uuid) from authenticated;
