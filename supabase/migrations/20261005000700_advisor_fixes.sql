-- =============================================================================
-- Portal de Projetos YouCon — Migration 0007: ajustes do consultor de segurança
--   * Funções de dias úteis viram SECURITY INVOKER (o auxiliar private.is_business_day
--     já faz a leitura protegida).
--   * A visão segura do cliente sai da API pública (schema private): só é usada
--     por get_home_dashboard, que roda sob o RLS do usuário.
-- =============================================================================
alter function public.next_business_day(date, uuid) security invoker;
alter function public.add_business_days(date, int, uuid) security invoker;
alter function public.business_days_between(date, date, uuid) security invoker;

alter function public.client_projects_overview() set schema private;
revoke all on function private.client_projects_overview() from public, anon;
grant execute on function private.client_projects_overview() to authenticated, service_role;

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
    return v_out || jsonb_build_object('client', jsonb_build_object('projects', private.client_projects_overview()));
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
