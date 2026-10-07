-- =============================================================================
-- Portal de Projetos YouCon — Migration 0019: liderança por área.
--
-- Cada projeto tem 3 líderes: Arquitetura, Engenharia e Aprovação (podem ser a
-- mesma pessoa). São definidos desde o início, mesmo que o cliente ainda não
-- tenha contratado serviços daquela área: quando contratar, o líder já existe.
-- Cada serviço indica a área de liderança a que pertence (configurável em
-- Serviços e Cronogramas). O antigo "Líder do Projeto" vira líder das 3 áreas.
-- =============================================================================

insert into public.project_roles (code, name, sort_order, required) values
  ('lead_architecture', 'Líder de Arquitetura', 1, true),
  ('lead_engineering',  'Líder de Engenharia',  2, true),
  ('lead_approval',     'Líder de Aprovação',   3, true)
on conflict (code) do update set name = excluded.name, sort_order = excluded.sort_order, required = true, active = true;
update public.project_roles set active = false, required = false where code = 'project_lead';

-- Área de liderança de cada serviço (padrão pela família; ajustável por serviço)
alter table public.services add column leadership_area text not null default 'architecture'
  check (leadership_area in ('architecture', 'engineering', 'approval'));
update public.services s set leadership_area = case f.code
    when 'engenharia' then 'engineering' when 'orcamentos' then 'engineering' when 'obra' then 'engineering'
    when 'aprovacoes' then 'approval' else 'architecture' end
  from public.service_families f where f.id = s.family_id;

-- Projetos existentes: o Líder do Projeto passa a liderar as 3 áreas
insert into public.project_team (project_id, user_id, project_role, employment_type, assigned_by, assigned_at)
select t.project_id, t.user_id, r, t.employment_type, t.assigned_by, t.assigned_at
from public.project_team t, unnest(array['lead_architecture', 'lead_engineering', 'lead_approval']) r
where t.project_role = 'project_lead' and t.active
  and not exists (select 1 from public.project_team x where x.project_id = t.project_id and x.project_role = r and x.active);
update public.project_team set active = false, removed_at = now()
 where project_role = 'project_lead' and active;

-- Líderes de um projeto: da área do serviço informado ou, sem serviço, os três.
create or replace function private.project_leaders(p_project uuid, p_project_service uuid default null)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(distinct t.user_id), '{}')
  from public.project_team t
  where t.project_id = p_project and t.active
    and t.project_role = any (
      case when p_project_service is null then array['lead_architecture', 'lead_engineering', 'lead_approval']
           else array[(select 'lead_' || s.leadership_area from public.project_services x
                        join public.services s on s.id = x.service_id where x.id = p_project_service)] end)
$$;
revoke all on function private.project_leaders(uuid, uuid) from public, anon;
grant execute on function private.project_leaders(uuid, uuid) to authenticated, service_role;

create or replace function private.assign_project_team(p_project uuid, p_assignments jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  a jsonb;
  u public.profiles;
  ps record;
  v_new int := 0;
  v_removed int := 0;
  v_started boolean := false;
  v_desired jsonb := '[]'::jsonb;
  v_resp uuid;
  d jsonb;
begin
  select * into p from public.projects where id = p_project for update;
  if p.id is null or not private.can_assign_team(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para definir a equipe' using errcode = '42501';
  end if;
  if p.status not in ('awaiting_team_assignment', 'in_progress', 'on_hold') then
    raise exception 'A equipe só pode ser definida após a distribuição do projeto' using errcode = '23514';
  end if;
  if jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    raise exception 'Defina os líderes de Arquitetura, Engenharia e Aprovação' using errcode = '23514';
  end if;
  -- Compatibilidade: "Líder do Projeto" único vira líder das três áreas.
  if not exists (select 1 from jsonb_array_elements(p_assignments) x where x ->> 'project_role' like 'lead\_%') then
    select coalesce(jsonb_agg(x), '[]'::jsonb) || coalesce((
             select jsonb_agg(jsonb_build_object('project_role', r, 'user_id', l ->> 'user_id'))
             from jsonb_array_elements(p_assignments) l, unnest(array['lead_architecture', 'lead_engineering', 'lead_approval']) r
             where l ->> 'project_role' = 'project_lead'), '[]'::jsonb)
      into p_assignments
    from jsonb_array_elements(p_assignments) x where x ->> 'project_role' is distinct from 'project_lead';
  end if;
  if (select count(distinct x ->> 'project_role') from jsonb_array_elements(p_assignments) x
      where x ->> 'project_role' in ('lead_architecture', 'lead_engineering', 'lead_approval') and nullif(x ->> 'user_id', '') is not null) < 3 then
    raise exception 'Defina os 3 líderes: Arquitetura, Engenharia e Aprovação (pode ser a mesma pessoa)' using errcode = '23514';
  end if;

  for a in select * from jsonb_array_elements(p_assignments) loop
    if nullif(a ->> 'user_id', '') is null then continue; end if;
    select * into u from public.profiles where id = (a ->> 'user_id')::uuid;
    if u.id is null or u.status <> 'ativo' or u.role not in ('collaborator', 'leader', 'unit_admin') then
      raise exception 'Responsável inválido ou inativo' using errcode = '23514';
    end if;
    if u.tenant_id is distinct from p.delivery_tenant_id then
      raise exception '% não pertence à unidade executora do projeto', u.name using errcode = '23514';
    end if;

    if nullif(a ->> 'project_service_id', '') is not null then
      select x.id, f.default_project_role into ps
      from public.project_services x
      join public.services s on s.id = x.service_id
      left join public.service_families f on f.id = s.family_id
      where x.id = (a ->> 'project_service_id')::uuid and x.project_id = p.id and x.active;
      if ps.id is null then raise exception 'Serviço não pertence a este projeto' using errcode = '23514'; end if;
      v_desired := v_desired || jsonb_build_object('role', coalesce(ps.default_project_role, 'support'), 'user', u.id);
    else
      if not exists (select 1 from public.project_roles r where r.code = a ->> 'project_role' and r.active) then
        raise exception 'Função de equipe inválida: %', a ->> 'project_role' using errcode = '23514';
      end if;
      v_desired := v_desired || jsonb_build_object('role', a ->> 'project_role', 'user', u.id);
    end if;
  end loop;

  -- Remove vínculos que saíram
  update public.project_team t
     set active = false, removed_at = now(), removed_by = private.current_profile_id()
   where t.project_id = p.id and t.active
     and not exists (select 1 from jsonb_array_elements(v_desired) x
                     where (x ->> 'user')::uuid = t.user_id and x ->> 'role' = t.project_role);
  get diagnostics v_removed = row_count;

  -- Cria vínculos novos
  for d in select distinct x from jsonb_array_elements(v_desired) x loop
    if not exists (select 1 from public.project_team t where t.project_id = p.id and t.active
                   and t.user_id = (d ->> 'user')::uuid and t.project_role = d ->> 'role') then
      select * into u from public.profiles where id = (d ->> 'user')::uuid;
      insert into public.project_team (project_id, user_id, project_role, employment_type, assigned_by)
      values (p.id, u.id, d ->> 'role', u.employment_type, private.current_profile_id());
      v_new := v_new + 1;
      if not exists (select 1 from public.project_team t where t.project_id = p.id and t.active and t.user_id = u.id
                     and t.project_role <> d ->> 'role') then
        perform private.notify(p.delivery_tenant_id, 'team_assigned', 'Você foi incluído em um projeto', p.name,
          'projects', p.id, jsonb_build_object('project_role', d ->> 'role'), null, u.id);
      end if;
    end if;
  end loop;

  -- Responsável direto de cada serviço; etapas abertas acompanham a troca.
  perform private.engine_on();
  for ps in select x.id, x.responsible_user_id from public.project_services x where x.project_id = p.id and x.active loop
    select nullif(x ->> 'user_id', '')::uuid into v_resp
    from jsonb_array_elements(p_assignments) x where x ->> 'project_service_id' = ps.id::text limit 1;
    if v_resp is distinct from ps.responsible_user_id then
      update public.project_services set responsible_user_id = v_resp where id = ps.id;
      update public.project_tasks t set responsible_user_id = v_resp
        from public.project_schedule_tracks tr
       where tr.id = t.schedule_track_id and tr.project_service_id = ps.id
         and t.status not in ('completed', 'cancelled')
         and (t.responsible_user_id is null or t.responsible_user_id is not distinct from ps.responsible_user_id);
    end if;
  end loop;

  if p.status = 'awaiting_team_assignment' then
    update public.projects set status = 'in_progress', started_at = now() where id = p.id;  -- gera o cronograma
    v_started := true;
  end if;
  perform private.resolve_notifications('project_awaiting_team', p.id);
  perform private.log_audit(case when v_started then 'team_confirmed_project_started' else 'team_changed' end,
    'projects', p.id, p.delivery_tenant_id,
    jsonb_build_object('assignments', p_assignments, 'added', v_new, 'removed', v_removed));

  return jsonb_build_object('project_id', p.id, 'started', v_started, 'added', v_new, 'removed', v_removed);
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
      if v_rec = 'project_lead' then
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

-- -----------------------------------------------------------------------------
-- Disparo
-- -----------------------------------------------------------------------------

revoke all on function private.automation_run_action(public.automation_rules, jsonb, public.projects, jsonb) from public, anon, authenticated;
