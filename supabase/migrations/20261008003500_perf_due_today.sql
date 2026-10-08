-- =============================================================================
-- 0035 · Performance: entrega que vence hoje e ainda não foi feita não conta
--        como prevista até o dia acabar (no mês em andamento).
-- =============================================================================

create or replace function private.perf_rows(p_from date, p_to date, p_people uuid[]) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with b as (
    select p_from as d0, least(p_to, private.today_br()) as d1
  ),
  units as (
    select t.responsible_user_id as pid, private.step_key(t.name) as akey, t.name as alabel, false as is_task,
           t.planned_end_date as due,
           case when t.status = 'completed'
                then coalesce(t.actual_end_date, (t.status_changed_at at time zone 'America/Sao_Paulo')::date) end as done
    from public.project_tasks t
    join public.projects p on p.id = t.project_id
    where t.responsible_user_id = any (p_people) and t.status <> 'cancelled' and p.status <> 'cancelled'
      and t.planned_end_date is not null and not t.auto_skipped
    union all
    select w.owner_id, 'tarefas da lideranca', 'Tarefas da liderança', true, w.due_date,
           (w.done_at at time zone 'America/Sao_Paulo')::date
    from public.work_items w
    join public.profiles o on o.id = w.owner_id
    left join public.performance_settings s on s.tenant_id = o.tenant_id
    where w.owner_id = any (p_people) and w.assigned_by is not null and coalesce(s.include_assigned_tasks, true)
  ),
  f as (
    select u.*,
      -- O que vence hoje e ainda não foi entregue não pesa contra (o dia não acabou).
      ((u.due between b.d0 and b.d1 and (u.done is null or u.done >= b.d0) and not (u.done is null and u.due >= private.today_br()))
        or (u.done between b.d0 and b.d1)) as in_p,
      coalesce(u.done between b.d0 and b.d1, false) as in_e,
      coalesce(u.done between b.d0 and b.d1 and u.done <= u.due, false) as in_t,
      (u.due < b.d1 and (u.done is null or u.done > b.d1)) as late_open,
      case when u.done between b.d0 and b.d1 and u.done > u.due then u.done - u.due end as late_days
    from units u, b
  ),
  agg as (
    select pid,
      count(*) filter (where in_p) as planned, count(*) filter (where in_e) as delivered,
      count(*) filter (where in_t) as on_time, count(*) filter (where late_open) as late_open,
      round(avg(late_days)::numeric, 1) as late_days_avg
    from f group by pid
  ),
  acts as (
    select pid, jsonb_agg(jsonb_build_object('key', akey, 'label', label, 'is_task', is_task,
                                             'planned', planned, 'delivered', delivered, 'on_time', on_time)
                          order by is_task, label) as activities
    from (select pid, akey, is_task, min(alabel) as label,
                 count(*) filter (where in_p) as planned, count(*) filter (where in_e) as delivered, count(*) filter (where in_t) as on_time
          from f group by pid, akey, is_task
          having count(*) filter (where in_p or in_e) > 0) x
    group by pid
  )
  select coalesce(jsonb_agg(r order by r ->> 'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', pr.id, 'name', pr.name, 'avatar_url', pr.avatar_url, 'role', pr.role, 'employment_type', pr.employment_type,
      'tenant_id', pr.tenant_id,
      'sector', case when sf.id is not null then jsonb_build_object('id', sf.id, 'name', sf.name) end,
      'planned', coalesce(a.planned, 0), 'delivered', coalesce(a.delivered, 0), 'on_time', coalesce(a.on_time, 0),
      'late_open', coalesce(a.late_open, 0), 'late_days_avg', a.late_days_avg,
      'delivery_pct', round(m.c * 100), 'on_time_pct', round(m.t * 100), 'no_backlog_pct', round(m.bk * 100),
      'score', sc.score,
      'band', case when sc.score is null then null when sc.score >= cfg.bg then 'great' when sc.score >= cfg.bo then 'ok' else 'low' end,
      'activities', coalesce(c.activities, '[]'::jsonb)) as r
    from public.profiles pr
    left join agg a on a.pid = pr.id
    left join acts c on c.pid = pr.id
    left join public.performance_settings s on s.tenant_id = pr.tenant_id
    left join public.service_families sf on sf.id = pr.sector_family_id
    cross join lateral (select coalesce(s.weight_delivery, 60) as wd, coalesce(s.weight_on_time, 30) as wt,
                               coalesce(s.weight_no_backlog, 10) as wb, coalesce(s.band_ok, 70) as bo, coalesce(s.band_great, 90) as bg) cfg
    cross join lateral (select
        case when coalesce(a.planned, 0) > 0 then least(1, a.delivered::numeric / a.planned) end as c,
        case when coalesce(a.delivered, 0) > 0 then a.on_time::numeric / a.delivered end as t,
        case when coalesce(a.planned, 0) > 0 or coalesce(a.late_open, 0) > 0
             then greatest(0, 1 - coalesce(a.late_open, 0)::numeric / greatest(coalesce(a.planned, 0), 1)) end as bk) m
    cross join lateral (select case
        when m.c is null and m.t is null and m.bk is null then null
        else round(100 * (cfg.wd * coalesce(m.c, 0) + cfg.wt * coalesce(m.t, 0) + cfg.wb * coalesce(m.bk, 0))
                   / nullif((case when m.c is not null then cfg.wd else 0 end) + (case when m.t is not null then cfg.wt else 0 end)
                            + (case when m.bk is not null then cfg.wb else 0 end), 0)) end as score) sc
    where pr.id = any (p_people)
  ) x
$$;
