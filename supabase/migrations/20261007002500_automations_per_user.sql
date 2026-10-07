-- =============================================================================
-- 0025 · Automações por usuário
--
-- Cada pessoa com acesso às automações (líder, ADM da unidade, ADM Global)
-- tem as SUAS automações: só ela vê, edita, liga/desliga e vê o histórico.
--   * owner_id: dono da automação (quem criou).
--   * A automação roda "como o dono": só nos projetos que ele enxerga, e
--     "definir responsável" só onde ele gerencia o cronograma. Se o dono perder
--     o acesso (inativo ou mudar de papel), as automações dele param.
--   * Novo destinatário de aviso: "owner" (eu, quem criou).
-- =============================================================================

alter table public.automation_rules add column owner_id uuid not null references public.profiles (id);
create index automation_rules_owner_idx on public.automation_rules (owner_id) where not archived;

-- Mesma regra de can_view_project / can_manage_project, para um perfil qualquer.
create or replace function private.profile_can_view_project(p_profile uuid, p_project uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles;
  p  public.projects;
begin
  select * into me from public.profiles where id = p_profile;
  select * into p from public.projects where id = p_project;
  if me.id is null or p.id is null or me.status <> 'ativo' then return false; end if;
  case me.role
    when 'global_admin' then return true;
    when 'unit_admin', 'leader' then return me.tenant_id in (p.delivery_tenant_id, p.commercial_tenant_id);
    when 'collaborator' then
      return exists (select 1 from public.project_team t where t.project_id = p.id and t.user_id = me.id and t.active);
    when 'client' then
      return exists (select 1 from public.client_contacts cc where cc.client_id = p.client_id and cc.profile_id = me.id and cc.active);
  end case;
  return false;
end;
$$;

create or replace function private.profile_can_manage_project(p_profile uuid, p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles me, public.projects p
    where me.id = p_profile and p.id = p_project and me.status = 'ativo'
      and (me.role = 'global_admin' or (me.role in ('unit_admin', 'leader') and p.delivery_tenant_id = me.tenant_id)))
$$;

-- Cada um vê só as suas automações e o histórico delas.
alter policy automation_rules_select on public.automation_rules
  using (owner_id = (select private.current_profile_id()));
alter policy automation_runs_select on public.automation_runs
  using (exists (select 1 from public.automation_rules ar where ar.id = rule_id and ar.owner_id = (select private.current_profile_id())));

create or replace function private.automation_emit(p_event text, p_project uuid, p_ctx jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_depth int := coalesce(nullif(current_setting('youcon.automation_depth', true), ''), '0')::int;
  p public.projects;
  r public.automation_rules;
  act jsonb;
  v_results jsonb;
  v_ok boolean;
  v_runs int := 0;
begin
  if v_depth >= 3 then return 0; end if;
  if not exists (select 1 from public.automation_rules where trigger = p_event and active and not archived) then return 0; end if;
  select * into p from public.projects where id = p_project;
  if p.id is null then return 0; end if;

  for r in
    select * from public.automation_rules ar
    where ar.trigger = p_event and ar.active and not ar.archived
      -- Automação pessoal: roda só nos projetos que o dono enxerga, e só enquanto ele tiver acesso.
      and private.profile_can_view_project(ar.owner_id, p.id)
      and exists (select 1 from public.profiles o where o.id = ar.owner_id and o.status = 'ativo'
                    and o.role in ('leader', 'unit_admin', 'global_admin'))
    order by ar.created_at
  loop
    if not private.automation_match(r, p, p_ctx) then continue; end if;
    perform set_config('youcon.automation_depth', (v_depth + 1)::text, true);
    v_results := '[]'::jsonb; v_ok := true;
    for act in select * from jsonb_array_elements(r.actions) loop
      begin
        v_results := v_results || jsonb_build_object('type', act ->> 'type', 'ok', true,
                                                     'message', private.automation_run_action(r, act, p, p_ctx));
      exception when others then
        v_ok := false;
        v_results := v_results || jsonb_build_object('type', act ->> 'type', 'ok', false, 'message', sqlerrm);
      end;
    end loop;
    perform set_config('youcon.automation_depth', v_depth::text, true);
    insert into public.automation_runs (rule_id, tenant_id, event, project_id, task_id, ok, results, context)
    values (r.id, r.tenant_id, p_event, p.id, (p_ctx ->> 'task_id')::uuid, v_ok, v_results, coalesce(p_ctx, '{}'::jsonb));
    update public.automation_rules set run_count = run_count + 1, last_run_at = now() where id = r.id;
    v_runs := v_runs + 1;
  end loop;
  return v_runs;
end;
$$;

create or replace function private.automation_run_action(r public.automation_rules, act jsonb, p public.projects, ctx jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text := act ->> 'type';
  v_users uuid[] := '{}';
  v_rec text;
  v_title text; v_body text;
  v_user uuid; v_n int := 0;
  t record;
begin
  if v_type = 'move_card' then
    if private.board_place(r.tenant_id, p.id, (act ->> 'column_id')::uuid, null, null) then
      return 'Card movido para "' || (select name from public.project_board_columns where id = (act ->> 'column_id')::uuid) || '"';
    end if;
    return 'Card já estava na coluna';

  elsif v_type = 'notify' then
    v_title := nullif(trim(private.automation_text(act ->> 'title', p, ctx)), '');
    v_body := private.automation_text(act ->> 'message', p, ctx);
    for v_rec in select jsonb_array_elements_text(coalesce(act -> 'recipients', '[]')) loop
      if v_rec = 'owner' then
        v_users := v_users || r.owner_id;
      elsif v_rec = 'project_lead' then
        v_users := v_users || private.project_leaders(p.id, (ctx ->> 'project_service_id')::uuid);
      elsif v_rec = 'task_responsible' then
        v_users := v_users || array(select responsible_user_id from public.project_tasks where id = (ctx ->> 'task_id')::uuid and responsible_user_id is not null);
      elsif v_rec = 'service_responsible' then
        v_users := v_users || array(select responsible_user_id from public.project_services
                                    where project_id = p.id and active and responsible_user_id is not null
                                      and (not ctx ? 'project_service_id' or id = (ctx ->> 'project_service_id')::uuid));
      elsif v_rec = 'project_team' then
        v_users := v_users || array(select user_id from public.project_team where project_id = p.id and active);
      elsif v_rec = 'unit_managers' then
        perform private.notify(r.tenant_id, 'automation', coalesce(v_title, r.name), v_body, 'projects', p.id,
          jsonb_build_object('rule_id', r.id), array['leader', 'unit_admin']::public.user_role[], null);
        v_n := v_n + 1;
      elsif v_rec like 'user:%' then
        v_users := v_users || substr(v_rec, 6)::uuid;
      end if;
    end loop;
    for v_user in select distinct u from unnest(v_users) u
                  join public.profiles pr on pr.id = u and pr.status = 'ativo' loop
      perform private.notify(coalesce(p.delivery_tenant_id, r.tenant_id), 'automation', coalesce(v_title, r.name), v_body,
        'projects', p.id, jsonb_build_object('rule_id', r.id, 'task_id', ctx ->> 'task_id'), null, v_user);
      v_n := v_n + 1;
    end loop;
    return case when v_n = 0 then 'Nenhum destinatário encontrado' else v_n || ' aviso(s) enviado(s)' end;

  elsif v_type = 'set_task_responsible' then
    if not private.profile_can_manage_project(r.owner_id, p.id) then
      raise exception 'Quem criou a automação não gerencia o cronograma deste projeto';
    end if;
    perform private.engine_on();
    for t in
      select pt.id, pt.name, pt.responsible_user_id, ps.responsible_user_id as direct
      from public.project_tasks pt
      join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
      join public.project_services ps on ps.id = tr.project_service_id
      join public.services s on s.id = ps.service_id
      where pt.project_id = p.id and pt.status not in ('completed', 'cancelled')
        and private.step_key(pt.name) = private.step_key(act ->> 'step')
        and (nullif(act ->> 'service', '') is null or s.code = act ->> 'service')
    loop
      v_user := case when act ->> 'assignee' = 'service_responsible' then t.direct
                     when act ->> 'assignee' like 'user:%' then substr(act ->> 'assignee', 6)::uuid end;
      if v_user is null or v_user is not distinct from t.responsible_user_id then continue; end if;
      if not exists (select 1 from public.profiles pr where pr.id = v_user and pr.status = 'ativo'
                       and pr.role in ('collaborator', 'leader', 'unit_admin') and pr.tenant_id = p.delivery_tenant_id) then
        raise exception 'Responsável inválido para a unidade executora';
      end if;
      update public.project_tasks set responsible_user_id = v_user where id = t.id;
      perform private.ensure_project_member(p.id, v_user);
      insert into public.task_changes (project_id, task_id, change_type, before, after, reason, changed_by)
      values (p.id, t.id, 'responsible', jsonb_build_object('responsible_user_id', t.responsible_user_id),
              jsonb_build_object('responsible_user_id', v_user), 'Automação: ' || r.name, null);
      perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Nova etapa sob sua responsabilidade',
        t.name || ' · ' || p.name, 'project_tasks', t.id, '{}'::jsonb, null, v_user);
      v_n := v_n + 1;
    end loop;
    return case when v_n = 0 then 'Nenhuma etapa aberta para alterar' else v_n || ' etapa(s) com novo responsável' end;
  end if;

  raise exception 'Ação desconhecida: %', v_type;
end;
$$;

create or replace function private.automation_save(p_id uuid, p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := private.current_tenant_id();
  v_trigger text := p_payload ->> 'trigger';
  v_actions jsonb := coalesce(p_payload -> 'actions', '[]'::jsonb);
  v_cond jsonb := coalesce(p_payload -> 'conditions', '{}'::jsonb);
  act jsonb; v_rec text; v_id uuid;
begin
  if not private.is_manager() or v_tenant is null then
    raise exception 'Seu perfil não tem acesso às automações' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_payload ->> 'name', ''))) = 0 then raise exception 'Dê um nome para a automação' using errcode = '23514'; end if;
  if v_trigger not in ('project_created', 'project_status_changed', 'task_started', 'task_completed',
                       'task_waiting_client', 'task_overdue', 'service_added', 'card_moved') then
    raise exception 'Escolha o gatilho da automação' using errcode = '23514';
  end if;
  if jsonb_typeof(v_actions) <> 'array' or jsonb_array_length(v_actions) = 0 then
    raise exception 'Adicione ao menos uma ação' using errcode = '23514';
  end if;
  if jsonb_typeof(v_cond) <> 'object' then raise exception 'Condições inválidas' using errcode = '22023'; end if;

  for act in select * from jsonb_array_elements(v_actions) loop
    if act ->> 'type' = 'move_card' then
      if not exists (select 1 from public.project_board_columns where id = (act ->> 'column_id')::uuid and tenant_id = v_tenant and active) then
        raise exception 'Escolha a coluna do quadro para onde o card vai' using errcode = '23514';
      end if;
    elsif act ->> 'type' = 'notify' then
      if jsonb_array_length(coalesce(act -> 'recipients', '[]')) = 0 then
        raise exception 'Escolha quem recebe o aviso' using errcode = '23514';
      end if;
      if length(trim(coalesce(act ->> 'title', ''))) = 0 then raise exception 'Escreva o título do aviso' using errcode = '23514'; end if;
      for v_rec in select jsonb_array_elements_text(act -> 'recipients') loop
        if v_rec like 'user:%' and not exists (select 1 from public.profiles where id = substr(v_rec, 6)::uuid and tenant_id = v_tenant) then
          raise exception 'A pessoa escolhida não pertence à sua unidade' using errcode = '23514';
        end if;
      end loop;
    elsif act ->> 'type' = 'set_task_responsible' then
      if length(trim(coalesce(act ->> 'step', ''))) = 0 then raise exception 'Escolha a etapa que recebe o responsável' using errcode = '23514'; end if;
      if coalesce(act ->> 'assignee', '') <> 'service_responsible'
         and not (act ->> 'assignee' like 'user:%' and exists (select 1 from public.profiles where id = substr(act ->> 'assignee', 6)::uuid and tenant_id = v_tenant)) then
        raise exception 'Escolha o responsável da etapa' using errcode = '23514';
      end if;
    else
      raise exception 'Ação inválida' using errcode = '23514';
    end if;
  end loop;

  if p_id is null then
    insert into public.automation_rules (tenant_id, owner_id, name, trigger, conditions, actions, active, created_by, updated_by)
    values (v_tenant, private.current_profile_id(), trim(p_payload ->> 'name'), v_trigger, v_cond, v_actions, coalesce((p_payload ->> 'active')::boolean, true),
            private.current_profile_id(), private.current_profile_id())
    returning id into v_id;
  else
    update public.automation_rules
       set name = trim(p_payload ->> 'name'), trigger = v_trigger, conditions = v_cond, actions = v_actions,
           active = coalesce((p_payload ->> 'active')::boolean, active), updated_by = private.current_profile_id()
     where id = p_id and owner_id = private.current_profile_id() and not archived
    returning id into v_id;
    if v_id is null then raise exception 'Automação não encontrada' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function private.automation_set_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Seu perfil não tem acesso às automações' using errcode = '42501'; end if;
  update public.automation_rules set active = p_active, updated_by = private.current_profile_id()
   where id = p_id and owner_id = private.current_profile_id() and not archived;
  if not found then raise exception 'Automação não encontrada' using errcode = 'P0002'; end if;
end;
$$;

create or replace function private.automation_archive(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Seu perfil não tem acesso às automações' using errcode = '42501'; end if;
  update public.automation_rules set archived = true, active = false, updated_by = private.current_profile_id()
   where id = p_id and owner_id = private.current_profile_id() and not archived;
  if not found then raise exception 'Automação não encontrada' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function private.profile_can_view_project(uuid, uuid), private.profile_can_manage_project(uuid, uuid) from public, anon, authenticated;
