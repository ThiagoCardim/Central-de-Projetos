-- =============================================================================
-- Portal de Projetos YouCon — Migration 0005: RPCs de usuários, unidades e Home.
--
-- RPCs de escrita são SECURITY INVOKER sempre que possível: rodam sob o RLS do
-- usuário, então a mesma regra protege a UI, a API e as Edge Functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Usuários
-- -----------------------------------------------------------------------------

-- Cria o perfil convidado (sem vínculo de auth ainda). A Edge Function
-- `admin-users` chama esta RPC com o JWT do administrador e, se aprovada,
-- envia o convite pelo Supabase Auth e vincula o auth_user_id.
create or replace function public.admin_prepare_user(
  p_tenant_id       uuid,
  p_name            text,
  p_email           text,
  p_role            public.user_role,
  p_employment_type public.employment_type default null,
  p_client_type     public.client_type default null,
  p_client_id       uuid default null,
  p_phone           text default null
) returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if private.current_profile_id() is null then
    raise exception 'Sessão inválida' using errcode = '42501';
  end if;
  if exists (select 1 from public.profiles where email = lower(trim(p_email))) then
    raise exception 'Já existe um usuário com este e-mail' using errcode = '23505';
  end if;
  if p_role = 'client' and p_client_id is null then
    raise exception 'Usuário cliente precisa estar vinculado a um cliente' using errcode = '23514';
  end if;

  -- id gerado antes: INSERT ... RETURNING exigiria visibilidade imediata da linha via SELECT policy.
  v_id := gen_random_uuid();
  insert into public.profiles (id, tenant_id, name, email, role, employment_type, client_type, phone, status, invited_by, invited_at)
  values (v_id, p_tenant_id, trim(p_name), lower(trim(p_email)), p_role,
          case when p_role = 'client' then null else p_employment_type end,
          case when p_role = 'client' then p_client_type end,
          p_phone, 'ativo', private.current_profile_id(), now());

  if p_role = 'client' then
    if not exists (select 1 from public.clients where id = p_client_id and tenant_id = p_tenant_id) then
      raise exception 'Cliente não encontrado nesta unidade' using errcode = '23503';
    end if;
    insert into public.client_contacts (client_id, profile_id, name, email, phone, is_primary)
    values (p_client_id, v_id, trim(p_name), lower(trim(p_email)), p_phone,
            not exists (select 1 from public.client_contacts where client_id = p_client_id and is_primary and active));
  end if;

  perform private.log_audit('user_invited', 'profiles', v_id, p_tenant_id,
    jsonb_build_object('role', p_role, 'employment_type', p_employment_type, 'client_type', p_client_type));
  return v_id;
end;
$$;

-- Vincula o usuário do Supabase Auth ao perfil. Somente service_role (Edge Function).
create or replace function public.admin_link_auth_user(p_profile_id uuid, p_auth_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.profiles set auth_user_id = p_auth_user_id
  where id = p_profile_id and auth_user_id is null;
$$;
revoke execute on function public.admin_link_auth_user(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_link_auth_user(uuid, uuid) to service_role;

-- Remove um perfil convidado cujo convite falhou (nunca vinculado). Somente service_role.
create or replace function public.admin_discard_pending_user(p_profile_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.client_contacts where profile_id = p_profile_id;
  delete from public.profiles where id = p_profile_id and auth_user_id is null;
$$;
revoke execute on function public.admin_discard_pending_user(uuid) from public, anon, authenticated;
grant execute on function public.admin_discard_pending_user(uuid) to service_role;

-- Edita dados do usuário (RLS + guardas validam papel/unidade).
create or replace function public.admin_update_user(
  p_profile_id      uuid,
  p_name            text,
  p_role            public.user_role,
  p_employment_type public.employment_type default null,
  p_client_type     public.client_type default null,
  p_phone           text default null,
  p_tenant_id       uuid default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.profiles set
    name            = trim(p_name),
    role            = p_role,
    employment_type = case when p_role = 'client' then null else p_employment_type end,
    client_type     = case when p_role = 'client' then p_client_type end,
    phone           = p_phone,
    tenant_id       = coalesce(p_tenant_id, tenant_id)
  where id = p_profile_id;
  if not found then
    raise exception 'Usuário não encontrado ou sem permissão' using errcode = '42501';
  end if;
end;
$$;

-- Ativa/desativa. Retorna o auth_user_id para a Edge Function encerrar sessões.
create or replace function public.admin_set_user_status(p_profile_id uuid, p_status public.record_status)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_auth uuid;
begin
  update public.profiles set status = p_status where id = p_profile_id
  returning auth_user_id into v_auth;
  if not found then
    raise exception 'Usuário não encontrado ou sem permissão' using errcode = '42501';
  end if;
  return v_auth;
end;
$$;

-- Permissões efetivas do usuário logado (UI usa para exibir/ocultar; o banco revalida tudo).
create or replace function public.my_permissions()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
begin
  if me.id is null then return null; end if;
  return jsonb_build_object(
    'profile_id',            me.id,
    'tenant_id',             me.tenant_id,
    'role',                  me.role,
    'employment_type',       me.employment_type,
    'client_type',           me.client_type,
    'can_manage_users',      private.can_manage_users(me.tenant_id),
    'can_manage_tenant',     private.can_manage_tenant(me.tenant_id),
    'can_manage_tenants',    private.can_manage_tenants(),
    'can_manage_templates',  private.can_manage_templates(),
    'can_distribute',        private.can_distribute_projects(),
    'can_view_intake',       private.can_view_intake(me.tenant_id),
    'can_view_performance',  private.can_view_performance(me.id),
    'is_manager',            private.is_manager(),
    'is_staff',              private.is_staff()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Unidades
-- -----------------------------------------------------------------------------
create or replace function public.admin_create_tenant(p_name text, p_slug text, p_city text default null, p_state text default null)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.tenants (name, type, parent_tenant_id, slug, city, state)
  values (trim(p_name), 'franquia',
          (select id from public.tenants where type = 'franqueadora'),
          lower(p_slug), p_city, upper(p_state))
  returning id into v_id;
  return v_id;
end;
$$;

-- Indicadores por unidade (ADM Global vê todas; ADM Unidade, a sua).
create or replace function public.tenant_overview()
returns table (
  tenant_id uuid, name text, type public.tenant_type, status public.record_status, city text, state text,
  users_active int, users_inactive int, collaborators_clt int, collaborators_pj int, clients int,
  projects_active int, projects_awaiting int, created_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.id, t.name, t.type, t.status, t.city, t.state,
    (select count(*) from public.profiles p where p.tenant_id = t.id and p.status = 'ativo' and p.role <> 'client')::int,
    (select count(*) from public.profiles p where p.tenant_id = t.id and p.status = 'inativo')::int,
    (select count(*) from public.profiles p where p.tenant_id = t.id and p.status = 'ativo' and p.employment_type = 'clt')::int,
    (select count(*) from public.profiles p where p.tenant_id = t.id and p.status = 'ativo' and p.employment_type = 'pj')::int,
    (select count(*) from public.clients c where c.tenant_id = t.id and c.status = 'ativo')::int,
    (select count(*) from public.projects pr where pr.delivery_tenant_id = t.id and pr.status = 'in_progress')::int,
    (select count(*) from public.projects pr where pr.delivery_tenant_id = t.id and pr.status in ('awaiting_allocation','awaiting_team_assignment'))::int,
    t.created_at
  from public.tenants t
  order by t.type, t.name
$$;

-- -----------------------------------------------------------------------------
-- Alertas de etapas (view sob RLS do usuário)
-- Regras (configuráveis no futuro por tenant):
--   atrasada     = prevista para terminar antes de hoje e não concluída/cancelada
--   bloqueada    = aguardando dependência ou terceiro
--   aguardando cliente = status waiting_client (dias desde a mudança de status)
-- -----------------------------------------------------------------------------
create or replace view public.task_alerts
with (security_invoker = true) as
select
  t.id as task_id, t.project_id, t.schedule_track_id, t.name as task_name, t.status,
  t.responsible_user_id, t.planned_start_date, t.planned_end_date,
  p.name as project_name, p.code as project_code, p.delivery_tenant_id,
  s.name as service_name,
  (t.planned_end_date - current_date) as due_in_days,
  case when t.planned_end_date < current_date and t.status not in ('completed','cancelled')
       then current_date - t.planned_end_date end as overdue_days,
  case when t.status in ('waiting_dependency','waiting_third_party','waiting_client')
       then (current_date - t.status_changed_at::date) end as waiting_days,
  (t.status not in ('completed','cancelled') and t.planned_end_date < current_date) as is_overdue,
  (t.status in ('waiting_dependency','waiting_third_party')) as is_blocked,
  (t.status = 'waiting_client') as is_waiting_client,
  (t.responsible_user_id is null and t.status not in ('completed','cancelled')) as is_unassigned
from public.project_tasks t
join public.projects p on p.id = t.project_id
join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
join public.project_services ps on ps.id = tr.project_service_id
join public.services s on s.id = ps.service_id
where p.status not in ('cancelled','completed');
grant select on public.task_alerts to authenticated;

-- -----------------------------------------------------------------------------
-- Visão do cliente: somente colunas seguras, sem justificativas internas.
-- -----------------------------------------------------------------------------
create or replace function public.client_projects_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
begin
  if me.id is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(proj order by proj ->> 'contracted_at' desc nulls last)
    from (
      select jsonb_build_object(
        'id', p.id, 'code', p.code, 'name', p.name, 'status', p.status,
        'city', p.city, 'state', p.state, 'contracted_at', p.contracted_at,
        'forecast_end', (select max(t.planned_end_date) from public.project_tasks t
                         where t.project_id = p.id and t.status <> 'cancelled'),
        'progress', coalesce((select round(100.0 * count(*) filter (where t.status = 'completed')
                                           / nullif(count(*), 0))
                              from public.project_tasks t where t.project_id = p.id and t.status <> 'cancelled'), 0),
        'pending_from_client', (select count(*) from public.project_tasks t
                                where t.project_id = p.id and t.status = 'waiting_client' and t.client_visible),
        'services', coalesce((
          select jsonb_agg(jsonb_build_object(
            'name', s.name,
            'track_status', tr.status,
            'progress', coalesce((select round(100.0 * count(*) filter (where t.status = 'completed') / nullif(count(*), 0))
                                  from public.project_tasks t where t.schedule_track_id = tr.id and t.status <> 'cancelled'), 0),
            'current_step', (select jsonb_build_object('name', t.name, 'status', t.status, 'planned_end_date', t.planned_end_date)
                             from public.project_tasks t
                             where t.schedule_track_id = tr.id and t.client_visible
                               and t.status in ('in_progress','waiting_client','waiting_third_party','overdue','ready')
                             order by t.sequence limit 1),
            'next_step', (select jsonb_build_object('name', t.name, 'planned_start_date', t.planned_start_date)
                          from public.project_tasks t
                          where t.schedule_track_id = tr.id and t.client_visible
                            and t.status in ('not_started','waiting_dependency')
                          order by t.sequence limit 1),
            'planned_end_date', tr.planned_end_date,
            'steps', coalesce((select jsonb_agg(jsonb_build_object('name', t.name, 'status', t.status,
                                 'planned_end_date', t.planned_end_date, 'actual_end_date', t.actual_end_date) order by t.sequence)
                               from public.project_tasks t
                               where t.schedule_track_id = tr.id and t.client_visible and t.status <> 'cancelled'), '[]'::jsonb)
          ) order by s.sort_order)
          from public.project_schedule_tracks tr
          join public.project_services ps on ps.id = tr.project_service_id and ps.active
          join public.services s on s.id = ps.service_id
          where tr.project_id = p.id), '[]'::jsonb)
      ) as proj
      from public.projects p
      where private.can_view_project(p.id)
        and (me.role <> 'client' or exists (select 1 from public.client_contacts cc
                                             where cc.client_id = p.client_id and cc.profile_id = me.id and cc.active))
        and p.status <> 'cancelled'
    ) x
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.client_projects_overview() from public, anon;
grant execute on function public.client_projects_overview() to authenticated;

-- -----------------------------------------------------------------------------
-- Home — "painel do avião". Um único payload por perfil, sempre sob RLS.
-- -----------------------------------------------------------------------------
create or replace function public.get_home_dashboard()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  me     public.profiles := private.current_profile();
  v_out  jsonb;
  v_today date := current_date;
begin
  if me.id is null then
    raise exception 'Sessão inválida' using errcode = '42501';
  end if;

  v_out := jsonb_build_object(
    'me', jsonb_build_object(
      'id', me.id, 'name', me.name, 'role', me.role, 'employment_type', me.employment_type,
      'client_type', me.client_type,
      'tenant', (select jsonb_build_object('id', t.id, 'name', t.name, 'type', t.type) from public.tenants t where t.id = me.tenant_id)),
    'generated_at', now()
  );

  -- Cliente: visão simplificada dos próprios projetos.
  if me.role = 'client' then
    return v_out || jsonb_build_object('client', jsonb_build_object('projects', public.client_projects_overview()));
  end if;

  -- Toda a equipe interna: minhas etapas.
  v_out := v_out || jsonb_build_object('my_work', jsonb_build_object(
    'counts', (select jsonb_build_object(
        'open',          count(*) filter (where a.status not in ('completed','cancelled')),
        'overdue',       count(*) filter (where a.is_overdue),
        'due_today',     count(*) filter (where a.due_in_days = 0 and not a.is_overdue and a.status not in ('completed','cancelled')),
        'due_next_7',    count(*) filter (where a.due_in_days between 1 and 7 and a.status not in ('completed','cancelled')),
        'waiting_client',count(*) filter (where a.is_waiting_client),
        'blocked',       count(*) filter (where a.is_blocked))
      from public.task_alerts a where a.responsible_user_id = me.id),
    'tasks', coalesce((select jsonb_agg(to_jsonb(a) order by a.is_overdue desc, a.planned_end_date nulls last)
      from (select * from public.task_alerts a
            where a.responsible_user_id = me.id and a.status not in ('completed','cancelled')
            order by a.is_overdue desc, a.planned_end_date nulls last limit 12) a), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'code', p.code, 'name', p.name, 'status', p.status,
                                  'project_role', pr.name) order by p.created_at desc)
      from public.project_team tm
      join public.projects p on p.id = tm.project_id
      join public.project_roles pr on pr.code = tm.project_role
      where tm.user_id = me.id and tm.active and p.status not in ('completed','cancelled')), '[]'::jsonb)
  ));

  -- Gestores (líder, ADM unidade, ADM global): operação da unidade.
  if me.role in ('leader','unit_admin','global_admin') then
    v_out := v_out || jsonb_build_object('operations', jsonb_build_object(
      'counts', (select jsonb_build_object(
          'projects_active',   (select count(*) from public.projects p where p.status = 'in_progress'),
          'awaiting_team',     (select count(*) from public.projects p where p.status = 'awaiting_team_assignment'),
          'awaiting_allocation',(select count(*) from public.projects p where p.status = 'awaiting_allocation'),
          'tasks_overdue',     count(*) filter (where a.is_overdue),
          'tasks_blocked',     count(*) filter (where a.is_blocked),
          'tasks_waiting_client', count(*) filter (where a.is_waiting_client),
          'tasks_unassigned',  count(*) filter (where a.is_unassigned),
          'due_next_7',        count(*) filter (where a.due_in_days between 0 and 7 and a.status not in ('completed','cancelled')),
          'projects_at_risk',  count(distinct a.project_id) filter (where a.is_overdue or (a.is_blocked and a.waiting_days >= 5)),
          'services_pending_review', (select count(*) from public.project_services ps where ps.status = 'pending_review' and ps.active))
        from public.task_alerts a),
      'awaiting_team', coalesce((select jsonb_agg(jsonb_build_object(
            'id', p.id, 'code', p.code, 'name', p.name, 'project_type', p.project_type, 'client_type', p.client_type,
            'client_name', c.name, 'city', p.city, 'state', p.state, 'contracted_at', p.contracted_at,
            'services', coalesce((select jsonb_agg(s.name order by s.sort_order) from public.project_services ps
                                  join public.services s on s.id = ps.service_id where ps.project_id = p.id and ps.active), '[]'::jsonb))
            order by p.contracted_at nulls last)
          from public.projects p join public.clients c on c.id = p.client_id
          where p.status = 'awaiting_team_assignment' and private.can_assign_team(p.id)), '[]'::jsonb),
      'alerts', coalesce((select jsonb_agg(to_jsonb(a)) from (
            select * from public.task_alerts a
            where a.is_overdue or a.is_blocked or a.is_waiting_client or a.is_unassigned
               or (a.due_in_days between 0 and 3 and a.status not in ('completed','cancelled'))
            order by a.is_overdue desc, a.overdue_days desc nulls last, a.due_in_days nulls last
            limit 20) a), '[]'::jsonb),
      'team_load', coalesce((select jsonb_agg(x order by (x ->> 'open')::int desc) from (
            select jsonb_build_object('id', pe.id, 'name', pe.name,
                     'open', count(a.task_id) filter (where a.status not in ('completed','cancelled')),
                     'overdue', count(a.task_id) filter (where a.is_overdue)) as x
            from public.people pe
            left join public.task_alerts a on a.responsible_user_id = pe.id
            where pe.status = 'ativo' and pe.role in ('collaborator','leader')
              and (me.role = 'global_admin' or pe.tenant_id = me.tenant_id)
            group by pe.id, pe.name
            limit 12) t), '[]'::jsonb)
    ));
  end if;

  -- ADM: governança (usuários, entrada, unidades).
  if me.role in ('unit_admin','global_admin') then
    v_out := v_out || jsonb_build_object('admin', jsonb_build_object(
      'users', (select jsonb_build_object(
          'active',   count(*) filter (where p.status = 'ativo' and p.role <> 'client'),
          'inactive', count(*) filter (where p.status = 'inativo'),
          'clt',      count(*) filter (where p.status = 'ativo' and p.employment_type = 'clt'),
          'pj',       count(*) filter (where p.status = 'ativo' and p.employment_type = 'pj'),
          'clients',  count(*) filter (where p.status = 'ativo' and p.role = 'client'),
          'pending_invite', count(*) filter (where p.auth_user_id is null))
        from public.profiles p where me.role = 'global_admin' or p.tenant_id = me.tenant_id),
      'intake', (select jsonb_build_object(
          'received', count(*) filter (where i.status in ('received','validated')),
          'errors',   count(*) filter (where i.status = 'error'),
          'last_24h', count(*) filter (where i.received_at > now() - interval '24 hours'))
        from public.project_intakes i),
      'tenants', case when me.role = 'global_admin'
                      then (select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) from public.tenant_overview() o)
                 end
    ));
  end if;

  return v_out;
end;
$$;
revoke execute on function public.get_home_dashboard() from public, anon;
grant execute on function public.get_home_dashboard() to authenticated;

revoke execute on function public.admin_prepare_user(uuid, text, text, public.user_role, public.employment_type, public.client_type, uuid, text),
                           public.admin_update_user(uuid, text, public.user_role, public.employment_type, public.client_type, text, uuid),
                           public.admin_set_user_status(uuid, public.record_status),
                           public.admin_create_tenant(text, text, text, text),
                           public.my_permissions(), public.tenant_overview() from public, anon;
grant execute on function public.admin_prepare_user(uuid, text, text, public.user_role, public.employment_type, public.client_type, uuid, text),
                          public.admin_update_user(uuid, text, public.user_role, public.employment_type, public.client_type, text, uuid),
                          public.admin_set_user_status(uuid, public.record_status),
                          public.admin_create_tenant(text, text, text, text),
                          public.my_permissions(), public.tenant_overview() to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
