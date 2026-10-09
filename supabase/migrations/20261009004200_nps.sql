-- =============================================================================
-- 0042 · NPS por serviço concluído
--
--   * Quando todas as etapas de um serviço do projeto terminam, o cliente vê
--     uma comemoração e a pesquisa: "De 0 a 10, quanto você recomendaria a
--     YouCon?" + comentário opcional. Pode responder depois (volta em 3 dias)
--     ou não responder.
--   * Vale para serviços concluídos a partir da ativação do NPS.
--   * Indicadores e respostas na aba Customer Success (CS e gestão).
--   * Nota de 0 a 6 (detrator) avisa o Customer Success.
-- =============================================================================

create table public.nps_settings (
  id         int primary key default 1 check (id = 1),
  started_on date not null default (now() at time zone 'America/Sao_Paulo')::date,
  question   text not null default 'De 0 a 10, quanto você recomendaria a YouCon para um amigo ou familiar?'
);
insert into public.nps_settings (id) values (1) on conflict do nothing;
alter table public.nps_settings enable row level security;
revoke all on public.nps_settings from anon, authenticated;

create table public.nps_responses (
  id                 uuid primary key default gen_random_uuid(),
  project_service_id uuid not null references public.project_services (id),
  project_id         uuid not null references public.projects (id),
  tenant_id          uuid references public.tenants (id),
  profile_id         uuid not null references public.profiles (id),
  status             text not null check (status in ('answered', 'snoozed', 'dismissed')),
  score              int check (score between 0 and 10),
  comment            text check (comment is null or length(comment) <= 2000),
  completed_on       date,
  snoozed_until      timestamptz,
  answered_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (project_service_id, profile_id),
  check (status <> 'answered' or score is not null)
);
create index nps_responses_tenant_idx on public.nps_responses (tenant_id, answered_at desc) where status = 'answered';
create trigger nps_responses_touch before update on public.nps_responses for each row execute function private.touch_updated_at();
alter table public.nps_responses enable row level security;
revoke all on public.nps_responses from anon, authenticated;

-- Serviços concluídos (todas as etapas encerradas, ao menos uma concluída) e quando.
create or replace function private.nps_completed_services()
returns table (project_service_id uuid, project_id uuid, tenant_id uuid, service_name text, completed_on date)
language sql stable security definer set search_path = ''
as $$
  select ps.id, ps.project_id, coalesce(p.delivery_tenant_id, p.commercial_tenant_id), s.name,
         max(t.actual_end_date)
  from public.project_services ps
  join public.projects p on p.id = ps.project_id
  join public.services s on s.id = ps.service_id
  join public.project_schedule_tracks tr on tr.project_service_id = ps.id
  join public.project_tasks t on t.schedule_track_id = tr.id
  where ps.active and ps.status in ('active', 'completed')
  group by ps.id, ps.project_id, p.delivery_tenant_id, p.commercial_tenant_id, s.name
  having bool_and(t.status in ('completed', 'cancelled')) and bool_or(t.status = 'completed')
     and max(t.actual_end_date) >= (select started_on from public.nps_settings where id = 1)
$$;

-- Pesquisas pendentes do cliente logado.
create or replace function private.nps_pending() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare me uuid := private.current_profile_id();
begin
  if me is null or private.my_role() <> 'client' then return '[]'::jsonb; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'project_service_id', c.project_service_id, 'project_id', c.project_id, 'project_name', p.name,
      'service_name', c.service_name, 'completed_on', c.completed_on,
      'question', (select question from public.nps_settings where id = 1)) order by c.completed_on), '[]'::jsonb)
    from private.nps_completed_services() c
    join public.projects p on p.id = c.project_id
    where private.can_view_project(c.project_id)
      and not exists (select 1 from public.nps_responses r
                      where r.project_service_id = c.project_service_id and r.profile_id = me
                        and (r.status in ('answered', 'dismissed') or r.snoozed_until > now())));
end;
$$;

create or replace function private.nps_check(p_ps uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare c jsonb;
begin
  if private.my_role() is distinct from 'client' then raise exception 'Pesquisa disponível só para o cliente' using errcode = '42501'; end if;
  select to_jsonb(x) into c from private.nps_completed_services() x where x.project_service_id = p_ps;
  if c is null or not private.can_view_project((c ->> 'project_id')::uuid) then
    raise exception 'Pesquisa não encontrada' using errcode = 'P0002';
  end if;
  return c;
end;
$$;

create or replace function private.nps_answer(p_ps uuid, p_score int, p_comment text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  j jsonb := private.nps_check(p_ps);
  c_project uuid := (j ->> 'project_id')::uuid;
  c_tenant uuid := (j ->> 'tenant_id')::uuid;
  c_service text := j ->> 'service_name';
  c_done date := (j ->> 'completed_on')::date;
  me uuid := private.current_profile_id();
  v_pname text;
  v_hq uuid;
begin
  if p_score is null or p_score not between 0 and 10 then raise exception 'Escolha uma nota de 0 a 10' using errcode = '23514'; end if;
  if exists (select 1 from public.nps_responses where project_service_id = p_ps and profile_id = me and status = 'answered') then
    raise exception 'Você já respondeu esta pesquisa' using errcode = '23514';
  end if;
  insert into public.nps_responses (project_service_id, project_id, tenant_id, profile_id, status, score, comment, completed_on, answered_at)
  values (p_ps, c_project, c_tenant, me, 'answered', p_score, nullif(left(trim(coalesce(p_comment, '')), 2000), ''), c_done, now())
  on conflict (project_service_id, profile_id) do update set status = 'answered', score = excluded.score, comment = excluded.comment,
    completed_on = excluded.completed_on, answered_at = now(), snoozed_until = null;

  -- Detrator: o Customer Success é avisado (unidade do projeto e Franqueadora).
  if p_score <= 6 then
    select name into v_pname from public.projects where id = c_project;
    perform private.notify(c_tenant, 'nps_detractor', 'NPS: cliente insatisfeito (nota ' || p_score || ')',
      c_service || ' · ' || v_pname, 'projects', c_project, jsonb_build_object('score', p_score), array['customer_success']::public.user_role[], null);
    select id into v_hq from public.tenants where type = 'franqueadora' order by created_at limit 1;
    if v_hq is not null and v_hq is distinct from c_tenant then
      perform private.notify(v_hq, 'nps_detractor', 'NPS: cliente insatisfeito (nota ' || p_score || ')',
        c_service || ' · ' || v_pname, 'projects', c_project, jsonb_build_object('score', p_score), array['customer_success']::public.user_role[], null);
    end if;
  end if;
end;
$$;

-- 'later': volta em 3 dias · 'never': não mostra mais
create or replace function private.nps_skip(p_ps uuid, p_mode text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  j jsonb := private.nps_check(p_ps);
  me uuid := private.current_profile_id();
begin
  if p_mode not in ('later', 'never') then raise exception 'Opção inválida' using errcode = '23514'; end if;
  insert into public.nps_responses (project_service_id, project_id, tenant_id, profile_id, status, completed_on, snoozed_until)
  values (p_ps, (j ->> 'project_id')::uuid, (j ->> 'tenant_id')::uuid, me, case when p_mode = 'later' then 'snoozed' else 'dismissed' end, (j ->> 'completed_on')::date,
          case when p_mode = 'later' then now() + interval '3 days' end)
  on conflict (project_service_id, profile_id) do update set
    status = case when public.nps_responses.status = 'answered' then 'answered' else excluded.status end,
    snoozed_until = excluded.snoozed_until;
end;
$$;

-- -----------------------------------------------------------------------------
-- Indicadores e respostas (CS e gestão), no escopo do que cada um vê
-- -----------------------------------------------------------------------------
create or replace function private.can_view_nps() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_cs() or private.is_manager() $$;

create or replace function private.nps_overview(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_to date := coalesce(p_to, private.today_br());
  v_from date := coalesce(p_from, private.today_br() - 89);
  v_days int;
begin
  if not private.can_view_nps() then raise exception 'Sem acesso ao NPS' using errcode = '42501'; end if;
  v_days := greatest(v_to - v_from + 1, 1);
  return (
    with ans as (
      select r.*, s.name as service_name, (r.answered_at at time zone 'America/Sao_Paulo')::date as day
      from public.nps_responses r
      join public.project_services ps on ps.id = r.project_service_id
      join public.services s on s.id = ps.service_id
      where r.status = 'answered' and (p_tenant is null or r.tenant_id = p_tenant) and private.can_view_project(r.project_id)
    ),
    cur as (select * from ans where day between v_from and v_to),
    prev as (select * from ans where day between v_from - v_days and v_from - 1),
    done as (
      select c.* from private.nps_completed_services() c
      where (p_tenant is null or c.tenant_id = p_tenant) and private.can_view_project(c.project_id)
        and c.completed_on between v_from and v_to
    )
    select jsonb_build_object(
      'from', v_from, 'to', v_to,
      'responses', (select count(*) from cur),
      'promoters', (select count(*) from cur where score >= 9),
      'passives', (select count(*) from cur where score between 7 and 8),
      'detractors', (select count(*) from cur where score <= 6),
      'nps', (select round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / nullif(count(*), 0)) from cur),
      'prev_nps', (select round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / nullif(count(*), 0)) from prev),
      'avg_score', (select round(avg(score)::numeric, 1) from cur),
      'completed_services', (select count(*) from done),
      'answered_services', (select count(*) from done d where exists (select 1 from public.nps_responses r where r.project_service_id = d.project_service_id and r.status = 'answered')),
      'pending_services', (select count(*) from done d where not exists (select 1 from public.nps_responses r where r.project_service_id = d.project_service_id and r.status in ('answered', 'dismissed'))),
      'distribution', (select jsonb_agg((select count(*) from cur where score = g) order by g) from generate_series(0, 10) g),
      'by_service', (select coalesce(jsonb_agg(x order by x.responses desc, x.service), '[]'::jsonb) from (
          select service_name as service, count(*) as responses,
                 round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / count(*)) as nps,
                 round(avg(score)::numeric, 1) as avg_score
          from cur group by service_name) x),
      'by_month', (select coalesce(jsonb_agg(jsonb_build_object('month', m,
                     'responses', (select count(*) from ans where date_trunc('month', day) = m),
                     'nps', (select round(100.0 * (count(*) filter (where score >= 9) - count(*) filter (where score <= 6)) / nullif(count(*), 0))
                             from ans where date_trunc('month', day) = m)) order by m), '[]'::jsonb)
                   from generate_series(date_trunc('month', v_to) - interval '5 months', date_trunc('month', v_to), interval '1 month') m)
    ));
end;
$$;

create or replace function private.nps_responses_list(p_tenant uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_view_nps() then raise exception 'Sem acesso ao NPS' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'score', r.score, 'comment', r.comment, 'answered_at', r.answered_at, 'completed_on', r.completed_on,
      'project_id', r.project_id, 'project_name', p.name, 'project_code', p.code, 'client_name', c.name,
      'service_name', s.name, 'respondent', pr.name, 'tenant_name', tn.name,
      'category', case when r.score >= 9 then 'promoter' when r.score >= 7 then 'passive' else 'detractor' end
    ) order by r.answered_at desc), '[]'::jsonb)
    from public.nps_responses r
    join public.projects p on p.id = r.project_id
    left join public.clients c on c.id = p.client_id
    join public.project_services ps on ps.id = r.project_service_id
    join public.services s on s.id = ps.service_id
    join public.profiles pr on pr.id = r.profile_id
    left join public.tenants tn on tn.id = r.tenant_id
    where r.status = 'answered' and (p_tenant is null or r.tenant_id = p_tenant)
      and (p_from is null or (r.answered_at at time zone 'America/Sao_Paulo')::date >= p_from)
      and (p_to is null or (r.answered_at at time zone 'America/Sao_Paulo')::date <= p_to)
      and private.can_view_project(r.project_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers
-- -----------------------------------------------------------------------------
create or replace function public.nps_pending() returns jsonb
language sql security invoker set search_path = '' as $$ select private.nps_pending() $$;
create or replace function public.nps_answer(p_ps uuid, p_score int, p_comment text) returns void
language sql security invoker set search_path = '' as $$ select private.nps_answer(p_ps, p_score, p_comment) $$;
create or replace function public.nps_skip(p_ps uuid, p_mode text) returns void
language sql security invoker set search_path = '' as $$ select private.nps_skip(p_ps, p_mode) $$;
create or replace function public.nps_overview(p_tenant uuid, p_from date, p_to date) returns jsonb
language sql security invoker set search_path = '' as $$ select private.nps_overview(p_tenant, p_from, p_to) $$;
create or replace function public.nps_responses_list(p_tenant uuid, p_from date, p_to date) returns jsonb
language sql security invoker set search_path = '' as $$ select private.nps_responses_list(p_tenant, p_from, p_to) $$;

revoke all on function private.nps_completed_services(), private.nps_pending(), private.nps_check(uuid), private.nps_answer(uuid, int, text),
  private.nps_skip(uuid, text), private.can_view_nps(), private.nps_overview(uuid, date, date), private.nps_responses_list(uuid, date, date),
  public.nps_pending(), public.nps_answer(uuid, int, text), public.nps_skip(uuid, text), public.nps_overview(uuid, date, date),
  public.nps_responses_list(uuid, date, date) from public, anon;
grant execute on function private.nps_completed_services(), private.nps_pending(), private.nps_check(uuid), private.nps_answer(uuid, int, text),
  private.nps_skip(uuid, text), private.can_view_nps(), private.nps_overview(uuid, date, date), private.nps_responses_list(uuid, date, date),
  public.nps_pending(), public.nps_answer(uuid, int, text), public.nps_skip(uuid, text), public.nps_overview(uuid, date, date),
  public.nps_responses_list(uuid, date, date) to authenticated;
