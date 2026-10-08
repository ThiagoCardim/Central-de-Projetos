-- =============================================================================
-- 0034 · Performance do time
--
--   * Setor de cada pessoa (família de serviço), definido pela gestão.
--   * Configuração por unidade: pesos da nota, faixas, volume mínimo para o
--     ranking/destaque, se tarefas da liderança contam e se PJ entra no destaque.
--   * Nota composta do mês, por pessoa, a partir de:
--       - etapas de projeto sob sua responsabilidade (com prazo);
--       - tarefas atribuídas pela liderança (tarefas pessoais não contam).
--     Cumprimento  = entregues no período ÷ previstas no período
--     Pontualidade = entregues até o prazo ÷ entregues
--     Sem atraso   = 1 − (abertas e vencidas ÷ previstas)
--     Nota = média ponderada dos componentes que existem no período.
--   * Visibilidade: gestão (líder/ADM da unidade, ADM global) vê a equipe,
--     inclusive PJ. O colaborador CLT vê a própria performance. O PJ não vê
--     a própria performance (é medida, mas não exibida para ele).
-- =============================================================================

alter table public.profiles add column sector_family_id uuid references public.service_families (id) on delete set null;

create table public.performance_settings (
  tenant_id              uuid primary key references public.tenants (id) on delete cascade,
  weight_delivery        int not null default 60 check (weight_delivery between 0 and 100),
  weight_on_time         int not null default 30 check (weight_on_time between 0 and 100),
  weight_no_backlog      int not null default 10 check (weight_no_backlog between 0 and 100),
  band_ok                int not null default 70 check (band_ok between 1 and 150),
  band_great             int not null default 90 check (band_great between 1 and 150),
  min_volume             int not null default 3 check (min_volume between 0 and 200),
  include_assigned_tasks boolean not null default true,
  highlight_includes_pj  boolean not null default false,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references public.profiles (id) on delete set null,
  constraint performance_settings_bands_chk check (band_great > band_ok),
  constraint performance_settings_weights_chk check (weight_delivery + weight_on_time + weight_no_backlog > 0)
);
alter table public.performance_settings enable row level security;
create policy performance_settings_select on public.performance_settings for select to authenticated
  using (private.can_access_tenant(tenant_id));
revoke all on public.performance_settings from anon;
grant select on public.performance_settings to authenticated;

-- Quem vê a performance de quem.
create or replace function private.can_view_performance(target_profile uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  t  public.profiles;
begin
  if me.id is null or me.status <> 'ativo' then return false; end if;
  select * into t from public.profiles where id = target_profile;
  if t.id is null then return false; end if;
  if me.id = t.id then
    -- O próprio: CLT vê; PJ não vê (medimos, mas não exibimos); ADM global vê.
    return me.role = 'global_admin' or (me.role in ('collaborator', 'leader', 'unit_admin') and me.employment_type = 'clt');
  end if;
  return private.can_lead_person(t.id);
end;
$$;

-- Hoje no fuso da operação.
create or replace function private.today_br() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

-- Linhas de performance (uma por pessoa) para o período.
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
      ((u.due between b.d0 and b.d1 and (u.done is null or u.done >= b.d0)) or (u.done between b.d0 and b.d1)) as in_p,
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

-- Evolução da nota (últimos meses) por pessoa: { profile_id: [{month, score, band}] }
create or replace function private.perf_trend(p_people uuid[], p_month date, p_months int default 6) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_object_agg(pid, arr), '{}'::jsonb) from (
    select r ->> 'id' as pid,
           jsonb_agg(jsonb_build_object('month', m::date, 'score', r -> 'score', 'band', r -> 'band') order by m) as arr
    from generate_series(date_trunc('month', p_month) - make_interval(months => p_months - 1), date_trunc('month', p_month), interval '1 month') m,
         lateral jsonb_array_elements(private.perf_rows(m::date, (m + interval '1 month' - interval '1 day')::date, p_people)) r
    group by 1
  ) x
$$;

-- Configuração efetiva da unidade.
create or replace function private.perf_settings_json(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'tenant_id', p_tenant,
    'weight_delivery', coalesce(s.weight_delivery, 60), 'weight_on_time', coalesce(s.weight_on_time, 30),
    'weight_no_backlog', coalesce(s.weight_no_backlog, 10), 'band_ok', coalesce(s.band_ok, 70), 'band_great', coalesce(s.band_great, 90),
    'min_volume', coalesce(s.min_volume, 3), 'include_assigned_tasks', coalesce(s.include_assigned_tasks, true),
    'highlight_includes_pj', coalesce(s.highlight_includes_pj, false))
  from (select 1) one left join public.performance_settings s on s.tenant_id = p_tenant
$$;

-- Pessoas da equipe interna que eu posso acompanhar (escopo de unidade).
create or replace function private.perf_people(p_tenant uuid) returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(t.id), '{}')
  from public.profiles t
  where t.status = 'ativo' and t.role in ('collaborator', 'leader', 'unit_admin')
    and (p_tenant is null or t.tenant_id = p_tenant)
    and private.can_view_performance(t.id)
$$;

-- Visão geral do mês.
create or replace function private.performance_overview(p_month date default null, p_tenant uuid default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  v_month date := date_trunc('month', coalesce(p_month, private.today_br()))::date;
  v_end date := (v_month + interval '1 month' - interval '1 day')::date;
  v_manager boolean := private.is_manager();
  v_tenant uuid;
  v_people uuid[];
begin
  if me.id is null or not private.is_staff() then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if not v_manager and not private.can_view_performance(me.id) then
    raise exception 'A performance não está disponível para o seu perfil' using errcode = '42501';
  end if;
  v_tenant := case when me.role = 'global_admin' then p_tenant else me.tenant_id end;
  v_people := case when v_manager then private.perf_people(v_tenant) else array[me.id] end;
  if not v_manager then v_tenant := me.tenant_id; end if;

  return jsonb_build_object(
    'month', v_month, 'month_end', v_end, 'cut', least(v_end, private.today_br()),
    'tenant_id', v_tenant,
    'settings', private.perf_settings_json(coalesce(v_tenant, me.tenant_id)),
    'scope', case when v_manager then 'team' else 'self' end,
    'can_configure', private.can_manage_tenant(coalesce(v_tenant, me.tenant_id)),
    'can_set_sector', v_manager,
    'sectors', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by f.sort_order, f.name), '[]'::jsonb)
                from public.service_families f where f.active),
    'people', private.perf_rows(v_month, v_end, v_people),
    'trend', private.perf_trend(v_people, v_month, 6));
end;
$$;

-- Detalhe de uma pessoa no mês.
create or replace function private.performance_person(p_profile uuid, p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_month date := date_trunc('month', coalesce(p_month, private.today_br()))::date;
  v_end date := (v_month + interval '1 month' - interval '1 day')::date;
  v_cut date := least(v_end, private.today_br());
  v_inc boolean;
begin
  if not private.can_view_performance(p_profile) then
    raise exception 'A performance não está disponível' using errcode = '42501';
  end if;
  select coalesce(s.include_assigned_tasks, true) into v_inc
    from public.profiles o left join public.performance_settings s on s.tenant_id = o.tenant_id where o.id = p_profile;

  return jsonb_build_object(
    'month', v_month, 'month_end', v_end, 'cut', v_cut,
    'person', private.perf_rows(v_month, v_end, array[p_profile]) -> 0,
    'trend', private.perf_trend(array[p_profile], v_month, 6) -> p_profile::text,
    'late', (select coalesce(jsonb_agg(x order by x ->> 'due'), '[]'::jsonb) from (
        select jsonb_build_object('kind', 'step', 'id', t.id, 'title', t.name, 'project_id', p.id, 'project', coalesce(p.code, p.name),
                                  'due', t.planned_end_date, 'status', t.status, 'days', v_cut - t.planned_end_date) as x
        from public.project_tasks t join public.projects p on p.id = t.project_id
        where t.responsible_user_id = p_profile and t.status not in ('completed', 'cancelled') and p.status <> 'cancelled'
          and t.planned_end_date < v_cut and not t.auto_skipped
        union all
        select jsonb_build_object('kind', 'task', 'id', w.id, 'title', w.title, 'project_id', w.project_id, 'project', null,
                                  'due', w.due_date, 'status', 'open', 'days', v_cut - w.due_date)
        from public.work_items w
        where v_inc and w.owner_id = p_profile and w.assigned_by is not null and w.done_at is null and w.due_date < v_cut
        limit 60) q),
    'delivered', (select coalesce(jsonb_agg(x order by x ->> 'done' desc), '[]'::jsonb) from (
        select jsonb_build_object('kind', 'step', 'id', t.id, 'title', t.name, 'project_id', p.id, 'project', coalesce(p.code, p.name),
                                  'due', t.planned_end_date, 'done', t.actual_end_date, 'late_days', greatest(0, t.actual_end_date - t.planned_end_date)) as x
        from public.project_tasks t join public.projects p on p.id = t.project_id
        where t.responsible_user_id = p_profile and t.status = 'completed' and t.actual_end_date between v_month and v_cut
          and t.planned_end_date is not null
        union all
        select jsonb_build_object('kind', 'task', 'id', w.id, 'title', w.title, 'project_id', w.project_id, 'project', null,
                                  'due', w.due_date, 'done', (w.done_at at time zone 'America/Sao_Paulo')::date,
                                  'late_days', greatest(0, (w.done_at at time zone 'America/Sao_Paulo')::date - w.due_date))
        from public.work_items w
        where v_inc and w.owner_id = p_profile and w.assigned_by is not null
          and (w.done_at at time zone 'America/Sao_Paulo')::date between v_month and v_cut
        limit 120) q));
end;
$$;

-- Destaques do mês por setor (gestão e CLT veem; PJ e cliente não).
create or replace function private.performance_highlights(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  v_month date := date_trunc('month', coalesce(p_month, private.today_br()))::date;
  v_end date := (v_month + interval '1 month' - interval '1 day')::date;
  v_set jsonb;
  v_people uuid[];
begin
  if me.id is null or not private.is_staff() then return null; end if;
  if not private.is_manager() and not private.can_view_performance(me.id) then return null; end if;
  v_set := private.perf_settings_json(me.tenant_id);
  select coalesce(array_agg(t.id), '{}') into v_people
    from public.profiles t
   where t.status = 'ativo' and t.role in ('collaborator', 'leader', 'unit_admin') and t.sector_family_id is not null
     and (t.tenant_id = me.tenant_id)
     and (t.employment_type = 'clt' or (v_set ->> 'highlight_includes_pj')::boolean);

  return jsonb_build_object('month', v_month, 'settings', v_set, 'items', (
    select coalesce(jsonb_agg(x order by x -> 'sector' ->> 'name'), '[]'::jsonb) from (
      select distinct on (r -> 'sector' ->> 'id')
             jsonb_build_object('sector', r -> 'sector',
               'person', jsonb_build_object('id', r ->> 'id', 'name', r ->> 'name', 'avatar_url', r ->> 'avatar_url'),
               'score', r -> 'score', 'band', r -> 'band', 'planned', r -> 'planned', 'delivered', r -> 'delivered',
               'on_time_pct', r -> 'on_time_pct') as x
      from jsonb_array_elements(private.perf_rows(v_month, v_end, v_people)) r
      where (r ->> 'score') is not null and (r ->> 'planned')::int >= (v_set ->> 'min_volume')::int
      order by r -> 'sector' ->> 'id', (r ->> 'score')::numeric desc, (r ->> 'delivered')::int desc, (r ->> 'on_time_pct')::numeric desc nulls last
    ) q));
end;
$$;

-- Setor da pessoa (gestão).
create or replace function private.set_profile_sector(p_profile uuid, p_family uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not (private.can_lead_person(p_profile) or private.can_manage_users((select tenant_id from public.profiles where id = p_profile))) then
    raise exception 'Sem permissão para definir o setor desta pessoa' using errcode = '42501';
  end if;
  if p_family is not null and not exists (select 1 from public.service_families where id = p_family and active) then
    raise exception 'Setor inválido' using errcode = '23514';
  end if;
  update public.profiles set sector_family_id = p_family where id = p_profile;
end;
$$;

-- Configuração (ADM da unidade / ADM global).
create or replace function private.save_performance_settings(p_tenant uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then
    raise exception 'Só o ADM da unidade altera as regras de performance' using errcode = '42501';
  end if;
  if coalesce((p ->> 'band_great')::int, 0) <= coalesce((p ->> 'band_ok')::int, 0) then
    raise exception 'A faixa "acima do esperado" precisa ser maior que a "satisfatória"' using errcode = '23514';
  end if;
  if coalesce((p ->> 'weight_delivery')::int, 0) + coalesce((p ->> 'weight_on_time')::int, 0) + coalesce((p ->> 'weight_no_backlog')::int, 0) <= 0 then
    raise exception 'Defina ao menos um peso maior que zero' using errcode = '23514';
  end if;
  insert into public.performance_settings as s (tenant_id, weight_delivery, weight_on_time, weight_no_backlog, band_ok, band_great,
                                                min_volume, include_assigned_tasks, highlight_includes_pj, updated_at, updated_by)
  values (p_tenant, (p ->> 'weight_delivery')::int, (p ->> 'weight_on_time')::int, (p ->> 'weight_no_backlog')::int,
          (p ->> 'band_ok')::int, (p ->> 'band_great')::int, (p ->> 'min_volume')::int,
          (p ->> 'include_assigned_tasks')::boolean, (p ->> 'highlight_includes_pj')::boolean, now(), private.current_profile_id())
  on conflict (tenant_id) do update set
    weight_delivery = excluded.weight_delivery, weight_on_time = excluded.weight_on_time, weight_no_backlog = excluded.weight_no_backlog,
    band_ok = excluded.band_ok, band_great = excluded.band_great, min_volume = excluded.min_volume,
    include_assigned_tasks = excluded.include_assigned_tasks, highlight_includes_pj = excluded.highlight_includes_pj,
    updated_at = now(), updated_by = excluded.updated_by;
  perform private.log_audit('performance_settings_changed', 'performance_settings', p_tenant, p_tenant, p);
  return private.perf_settings_json(p_tenant);
end;
$$;

-- Wrappers públicos
create or replace function public.performance_overview(p_month date default null, p_tenant uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.performance_overview(p_month, p_tenant) $$;
create or replace function public.performance_person(p_profile uuid, p_month date default null) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.performance_person(p_profile, p_month) $$;
create or replace function public.performance_highlights(p_month date default null) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.performance_highlights(p_month) $$;
create or replace function public.set_profile_sector(p_profile uuid, p_family uuid) returns void
language sql security invoker set search_path = '' as $$ select private.set_profile_sector(p_profile, p_family) $$;
create or replace function public.save_performance_settings(p_tenant uuid, p jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.save_performance_settings(p_tenant, p) $$;

-- perf_rows/perf_trend/perf_people não são expostas: só as funções de visão (que checam permissão).
revoke all on function private.perf_rows(date, date, uuid[]), private.perf_trend(uuid[], date, int), private.perf_people(uuid),
  private.perf_settings_json(uuid) from public, anon, authenticated;
revoke all on function private.performance_overview(date, uuid), private.performance_person(uuid, date), private.performance_highlights(date),
  private.set_profile_sector(uuid, uuid), private.save_performance_settings(uuid, jsonb), private.today_br(),
  public.performance_overview(date, uuid), public.performance_person(uuid, date), public.performance_highlights(date),
  public.set_profile_sector(uuid, uuid), public.save_performance_settings(uuid, jsonb) from public, anon;
grant execute on function private.performance_overview(date, uuid), private.performance_person(uuid, date), private.performance_highlights(date),
  private.set_profile_sector(uuid, uuid), private.save_performance_settings(uuid, jsonb), private.today_br(),
  public.performance_overview(date, uuid), public.performance_person(uuid, date), public.performance_highlights(date),
  public.set_profile_sector(uuid, uuid), public.save_performance_settings(uuid, jsonb) to authenticated;
