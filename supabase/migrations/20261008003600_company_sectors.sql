-- =============================================================================
-- 0036 · Setores da empresa (cadastro da administração)
--
--   * Setores passam a ser um cadastro próprio, por unidade, mantido pela
--     administração (ADM da unidade / ADM global) em Configurações.
--     Não dependem mais das famílias de serviço.
--   * Atribuições atuais são migradas (Arquitetura, Engenharia, Interiores,
--     Aprovação). A coluna antiga profiles.sector_family_id deixa de ser usada.
--   * Performance (ranking e destaques) usa o novo cadastro.
-- =============================================================================

create table public.sectors (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null check (length(trim(name)) between 2 and 60),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sectors_tenant_name_key on public.sectors (tenant_id, lower(trim(name)));
create trigger sectors_touch before update on public.sectors for each row execute function private.touch_updated_at();
alter table public.sectors enable row level security;
create policy sectors_select on public.sectors for select to authenticated using (private.can_access_tenant(tenant_id));
revoke all on public.sectors from anon;
grant select on public.sectors to authenticated;

alter table public.profiles add column sector_id uuid references public.sectors (id) on delete set null;

-- Setores iniciais de cada unidade (os das planilhas de metas)
insert into public.sectors (tenant_id, name, sort_order)
select t.id, s.name, s.ord from public.tenants t
cross join (values ('Arquitetura', 10), ('Engenharia', 20), ('Interiores', 30), ('Aprovação', 40)) s(name, ord)
on conflict do nothing;

-- Migra quem já tinha setor (pela família de serviço)
insert into public.sectors (tenant_id, name, sort_order)
select distinct p.tenant_id, f.name, 90 from public.profiles p join public.service_families f on f.id = p.sector_family_id
where f.code not in ('arquitetura', 'engenharia', 'interiores', 'aprovacoes')
on conflict do nothing;
update public.profiles p set sector_id = s.id
  from public.service_families f, public.sectors s
 where f.id = p.sector_family_id and s.tenant_id = p.tenant_id
   and lower(s.name) = lower(case f.code when 'aprovacoes' then 'Aprovação' else f.name end);
update public.profiles set sector_family_id = null where sector_family_id is not null;

-- ---------------------------------------------------------------------------
-- Cadastro (só administração)
-- ---------------------------------------------------------------------------
create or replace function private.sector_save(p_tenant uuid, p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid; v_tenant uuid := p_tenant;
begin
  if p_id is not null then select tenant_id into v_tenant from public.sectors where id = p_id; end if;
  if v_tenant is null or not private.can_manage_tenant(v_tenant) then
    raise exception 'Só a administração altera os setores' using errcode = '42501';
  end if;
  if nullif(trim(p_name), '') is null or length(trim(p_name)) < 2 then raise exception 'Informe o nome do setor' using errcode = '23514'; end if;
  if exists (select 1 from public.sectors where tenant_id = v_tenant and lower(trim(name)) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'Já existe um setor com esse nome' using errcode = '23505';
  end if;
  if p_id is null then
    insert into public.sectors (tenant_id, name, sort_order)
    values (v_tenant, trim(p_name), coalesce((select max(sort_order) from public.sectors where tenant_id = v_tenant), 0) + 10)
    returning id into v_id;
  else
    update public.sectors set name = trim(p_name) where id = p_id returning id into v_id;
  end if;
  perform private.log_audit(case when p_id is null then 'sector_created' else 'sector_renamed' end, 'sectors', v_id, v_tenant,
    jsonb_build_object('name', trim(p_name)));
  return v_id;
end;
$$;

create or replace function private.sector_delete(p_id uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare s public.sectors; v_n int;
begin
  select * into s from public.sectors where id = p_id;
  if s.id is null then raise exception 'Setor não encontrado' using errcode = 'P0002'; end if;
  if not private.can_manage_tenant(s.tenant_id) then raise exception 'Só a administração altera os setores' using errcode = '42501'; end if;
  select count(*) into v_n from public.profiles where sector_id = p_id;
  delete from public.sectors where id = p_id;   -- as pessoas ficam sem setor
  perform private.log_audit('sector_deleted', 'sectors', p_id, s.tenant_id, jsonb_build_object('name', s.name, 'people', v_n));
  return v_n;
end;
$$;

create or replace function private.sector_reorder(p_tenant uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Só a administração altera os setores' using errcode = '42501'; end if;
  update public.sectors s set sort_order = x.ord * 10
    from unnest(p_ids) with ordinality x(id, ord)
   where s.id = x.id and s.tenant_id = p_tenant;
end;
$$;

-- Setor da pessoa (gestão): o setor precisa ser da unidade da pessoa.
create or replace function private.set_person_sector(p_profile uuid, p_sector uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.profiles where id = p_profile;
  if not (private.can_lead_person(p_profile) or private.can_manage_users(v_tenant)) then
    raise exception 'Sem permissão para definir o setor desta pessoa' using errcode = '42501';
  end if;
  if p_sector is not null and not exists (select 1 from public.sectors where id = p_sector and tenant_id = v_tenant) then
    raise exception 'Setor inválido para a unidade desta pessoa' using errcode = '23514';
  end if;
  update public.profiles set sector_id = p_sector where id = p_profile;
end;
$$;
-- Compatibilidade: a função antiga passa a receber o id do setor.
create or replace function private.set_profile_sector(p_profile uuid, p_family uuid) returns void
language sql security definer set search_path = '' as $$ select private.set_person_sector(p_profile, p_family) $$;

-- Quantas pessoas em cada setor (para a tela de configurações).
create or replace function private.sector_list(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'sort_order', s.sort_order,
    'people', (select count(*) from public.profiles p where p.sector_id = s.id and p.status = 'ativo')) order by s.sort_order, s.name), '[]'::jsonb)
  from public.sectors s
  where s.tenant_id = p_tenant and private.can_access_tenant(p_tenant)
$$;

-- ---------------------------------------------------------------------------
-- Performance com o novo cadastro
-- ---------------------------------------------------------------------------
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
    left join public.sectors sf on sf.id = pr.sector_id
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
  v_tenant := case when me.role = 'global_admin' then coalesce(p_tenant, me.tenant_id) else me.tenant_id end;
  v_people := case when v_manager then private.perf_people(v_tenant) else array[me.id] end;
  if not v_manager then v_tenant := me.tenant_id; end if;

  return jsonb_build_object(
    'month', v_month, 'month_end', v_end, 'cut', least(v_end, private.today_br()),
    'tenant_id', v_tenant,
    'settings', private.perf_settings_json(coalesce(v_tenant, me.tenant_id)),
    'scope', case when v_manager then 'team' else 'self' end,
    'can_configure', private.can_manage_tenant(coalesce(v_tenant, me.tenant_id)),
    'can_set_sector', v_manager,
    'sectors', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.sort_order, x.name), '[]'::jsonb)
                from public.sectors x where x.tenant_id = coalesce(v_tenant, me.tenant_id)),
    'people', private.perf_rows(v_month, v_end, v_people),
    'trend', private.perf_trend(v_people, v_month, 6));
end;
$$;

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
   where t.status = 'ativo' and t.role in ('collaborator', 'leader', 'unit_admin') and t.sector_id is not null
     and (t.tenant_id = me.tenant_id)
     and (t.employment_type = 'clt' or (v_set ->> 'highlight_includes_pj')::boolean);

  return jsonb_build_object('month', v_month, 'settings', v_set, 'items', (
    select coalesce(jsonb_agg(x order by (select s.sort_order from public.sectors s where s.id = (x -> 'sector' ->> 'id')::uuid), x -> 'sector' ->> 'name'), '[]'::jsonb) from (
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


create or replace function public.sector_save(p_tenant uuid, p_id uuid, p_name text) returns uuid
language sql security invoker set search_path = '' as $$ select private.sector_save(p_tenant, p_id, p_name) $$;
create or replace function public.sector_delete(p_id uuid) returns int
language sql security invoker set search_path = '' as $$ select private.sector_delete(p_id) $$;
create or replace function public.sector_reorder(p_tenant uuid, p_ids uuid[]) returns void
language sql security invoker set search_path = '' as $$ select private.sector_reorder(p_tenant, p_ids) $$;
create or replace function public.set_person_sector(p_profile uuid, p_sector uuid) returns void
language sql security invoker set search_path = '' as $$ select private.set_person_sector(p_profile, p_sector) $$;
create or replace function public.sector_list(p_tenant uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.sector_list(p_tenant) $$;

revoke all on function private.sector_save(uuid, uuid, text), private.sector_delete(uuid), private.sector_reorder(uuid, uuid[]),
  private.set_person_sector(uuid, uuid), private.sector_list(uuid),
  public.sector_save(uuid, uuid, text), public.sector_delete(uuid), public.sector_reorder(uuid, uuid[]),
  public.set_person_sector(uuid, uuid), public.sector_list(uuid) from public, anon;
grant execute on function private.sector_save(uuid, uuid, text), private.sector_delete(uuid), private.sector_reorder(uuid, uuid[]),
  private.set_person_sector(uuid, uuid), private.sector_list(uuid),
  public.sector_save(uuid, uuid, text), public.sector_delete(uuid), public.sector_reorder(uuid, uuid[]),
  public.set_person_sector(uuid, uuid), public.sector_list(uuid) to authenticated;
