-- =============================================================================
-- 0046 · Prazo de retorno do cliente
--
--   O cronograma depende do retorno do cliente. Quando a equipe espera por ele,
--   abre-se uma "espera" com prazo (padrão 2 dias úteis, por unidade):
--     * automática: publicação de apresentação/revisão em Entregas;
--     * manual: etapa marcada como "Aguardando cliente" no cronograma.
--   A espera termina quando o cliente aprova ou pede revisão (portal ou equipe
--   em nome dele), quando a etapa sai de "Aguardando cliente", ou quando o
--   responsável/líder registra "Cliente retornou" com a data real.
--
--   Passado o prazo, cada dia útil sem retorno empurra o projeto em +1 dia útil
--   (mesma regra do atraso: todas as etapas não iniciadas andam), com o motivo
--   "Aguardando aprovação ou retorno do cliente", visível ao cliente.
--   Retorno com data anterior devolve os dias empurrados a mais; o líder da área
--   (ou ADM) pode abonar dias combinados com o cliente.
-- =============================================================================

create table public.client_wait_settings (
  tenant_id  uuid primary key references public.tenants (id),
  enabled    boolean not null default true,
  days       int not null default 2 check (days between 1 and 15),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.client_wait_settings enable row level security;
revoke all on public.client_wait_settings from anon, authenticated;

create table public.client_waits (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id),
  tenant_id      uuid references public.tenants (id),
  source         text not null check (source in ('delivery', 'task')),
  delivery_id    uuid references public.project_deliveries (id),
  version_id     uuid references public.delivery_versions (id),
  task_id        uuid references public.project_tasks (id),
  label          text not null,
  started_on     date not null,
  due_on         date not null,
  started_by     uuid references public.profiles (id),
  waived_until   date,
  waive_reason   text,
  waived_by      uuid references public.profiles (id),
  waived_at      timestamptz,
  returned_on    date,
  returned_by    uuid references public.profiles (id),
  returned_note  text check (returned_note is null or length(returned_note) <= 1000),
  close_source   text check (close_source in ('portal', 'team', 'status', 'cancelled')),
  closed_at      timestamptz,
  reminded_at    timestamptz,
  late_notified_at timestamptz,
  created_at     timestamptz not null default now(),
  constraint client_waits_ref_chk check ((source = 'delivery' and delivery_id is not null) or (source = 'task' and task_id is not null))
);
create index client_waits_project_idx on public.client_waits (project_id, closed_at);
create unique index client_waits_open_task on public.client_waits (task_id) where closed_at is null and source = 'task';
create unique index client_waits_open_delivery on public.client_waits (delivery_id) where closed_at is null and source = 'delivery';

create table public.client_wait_pushes (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id),
  day            date not null,
  wait_id        uuid not null references public.client_waits (id),
  anchor_task_id uuid references public.project_tasks (id),
  change_id      uuid references public.task_changes (id) on delete set null,
  details        jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  refunded_at    timestamptz,
  refund_reason  text
);
-- Um empurrão por projeto por dia (dias devolvidos podem voltar a valer por outra espera).
create unique index client_wait_pushes_day on public.client_wait_pushes (project_id, day) where refunded_at is null;
create index client_wait_pushes_wait_idx on public.client_wait_pushes (wait_id);

alter table public.client_waits enable row level security;
alter table public.client_wait_pushes enable row level security;
revoke all on public.client_waits, public.client_wait_pushes from anon, authenticated;
create trigger client_waits_audit after insert or update on public.client_waits for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Regras
-- -----------------------------------------------------------------------------
create or replace function private.client_wait_rules(p_tenant uuid, out enabled boolean, out days int)
language sql stable security definer set search_path = ''
as $$
  select coalesce(s.enabled, true), coalesce(s.days, 2)
  from (select 1) one left join public.client_wait_settings s on s.tenant_id = p_tenant
$$;

create or replace function private.client_wait_cal(p_project uuid) returns uuid
language sql stable security definer set search_path = ''
as $$ select private.calendar_for_tenant(p.delivery_tenant_id) from public.projects p where p.id = p_project $$;

-- Serviço (project_service) ligado à espera: da entrega ou da trilha da etapa.
create or replace function private.client_wait_ps(w public.client_waits) returns uuid
language sql stable security definer set search_path = ''
as $$
  select case when w.source = 'delivery' then (select d.project_service_id from public.project_deliveries d where d.id = w.delivery_id)
              else (select tr.project_service_id from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
                     where t.id = w.task_id) end
$$;

-- Registrar retorno: responsável (da etapa ou da versão) e líderes do projeto (e gestão).
create or replace function private.can_return_wait(w public.client_waits) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_edit_schedule(w.project_id)
      or private.current_profile_id() = any (private.project_leaders(w.project_id, null))
      or (w.source = 'task' and exists (select 1 from public.project_tasks t where t.id = w.task_id and t.responsible_user_id = private.current_profile_id()))
      or (w.source = 'delivery' and (
            exists (select 1 from public.delivery_versions v where v.id = w.version_id and v.responsible_id = private.current_profile_id())
            or private.delivery_creation_responsible((select d.project_service_id from public.project_deliveries d where d.id = w.delivery_id)) = private.current_profile_id()))
$$;

-- Abonar: líder da área do serviço no projeto, ADM da unidade ou ADM Global.
create or replace function private.can_waive_wait(w public.client_waits) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.my_role() = 'unit_admin' and private.can_manage_project(w.project_id))
      or private.current_profile_id() = any (private.project_leaders(w.project_id, private.client_wait_ps(w)))
$$;

-- Um dia de atraso é "justificado" por uma espera quando ela estava aberta e vencida nele, sem abono.
create or replace function private.client_wait_covers(w public.client_waits, p_day date) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_day > w.due_on
     and (w.returned_on is null or p_day < w.returned_on)   -- no dia do retorno já não conta
     and w.close_source is distinct from 'cancelled'
     and (w.waived_until is null or p_day > w.waived_until)
$$;

-- -----------------------------------------------------------------------------
-- Abrir e fechar esperas
-- -----------------------------------------------------------------------------
create or replace function private.client_wait_open(p_project uuid, p_source text, p_delivery uuid, p_version uuid, p_task uuid, p_label text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  r record;
  v_today date := private.today_br();
  v_id uuid;
  v_due date;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or p.status <> 'in_progress' then return null; end if;
  select * into r from private.client_wait_rules(p.delivery_tenant_id);
  if not r.enabled then return null; end if;
  v_due := public.add_business_days(v_today + 1, r.days, private.calendar_for_tenant(p.delivery_tenant_id));
  insert into public.client_waits (project_id, tenant_id, source, delivery_id, version_id, task_id, label, started_on, due_on, started_by)
  values (p.id, p.delivery_tenant_id, p_source, p_delivery, p_version, p_task, left(p_label, 200), v_today, v_due, private.current_profile_id())
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.prev_business_day(p_date date, p_calendar uuid) returns date
language plpgsql stable security definer set search_path = ''
as $$
declare d date := p_date - 1;
begin
  while not private.is_business_day(d, p_calendar) loop d := d - 1; end loop;
  return d;
end;
$$;

-- Devolve (ou repassa para outra espera vencida) os dias empurrados de uma espera.
create or replace function private.client_wait_refund(p_wait uuid, p_after date, p_upto date, p_reason text) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  pu record;
  e jsonb;
  o public.client_waits;
  v_n int := 0;
  v_rep public.project_tasks;
  v_rep2 public.project_tasks;
  v_ids uuid[];
  cal uuid;
begin
  select * into w from public.client_waits where id = p_wait;
  cal := private.client_wait_cal(w.project_id);
  perform private.engine_on();
  for pu in select * from public.client_wait_pushes
            where wait_id = w.id and refunded_at is null
              and (p_after is null or day > p_after) and (p_upto is null or day <= p_upto)
            order by day desc
  loop
    -- Outra espera do projeto também vencida nesse dia? O dia continua valendo, por ela.
    select * into o from public.client_waits x
     where x.project_id = w.project_id and x.id <> w.id and private.client_wait_covers(x, pu.day)
     order by x.started_on limit 1;
    if o.id is not null then
      update public.client_wait_pushes set wait_id = o.id where id = pu.id;
      continue;
    end if;
    if v_rep.id is null then select * into v_rep from public.project_tasks where id = pu.anchor_task_id; end if;
    -- Cada empurrão somou 1 dia útil; devolver tira 1 dia útil das mesmas etapas
    -- (vale para qualquer dia, não só o último), sem voltar além do valor anterior.
    for e in select * from jsonb_array_elements(pu.details) loop
      if e ->> 'f' = 'dur' then
        update public.project_tasks set planned_duration_days = planned_duration_days - 1
         where id = (e ->> 'id')::uuid and planned_duration_days > (e ->> 'b')::int;
      elsif e ->> 'b' is null then
        update public.project_tasks
           set start_not_before = case when start_not_before = (e ->> 'a')::date then null
                                       else private.prev_business_day(start_not_before, cal) end
         where id = (e ->> 'id')::uuid and start_not_before is not null;
      else
        update public.project_tasks set start_not_before = greatest((e ->> 'b')::date, private.prev_business_day(start_not_before, cal))
         where id = (e ->> 'id')::uuid and start_not_before > (e ->> 'b')::date;
      end if;
    end loop;
    update public.client_wait_pushes set refunded_at = now(), refund_reason = p_reason where id = pu.id;
    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    v_ids := private.apply_schedule(w.project_id);
    if v_rep.id is not null then
      select * into v_rep2 from public.project_tasks where id = v_rep.id;
      insert into public.task_changes (project_id, task_id, change_type, before, after, reason, impacted_task_ids, changed_by)
      values (w.project_id, v_rep.id, 'reschedule', private.task_snapshot(v_rep), private.task_snapshot(v_rep2) || jsonb_build_object('refunded_days', v_n),
              p_reason, array_remove(v_ids, v_rep.id), private.current_profile_id());
    end if;
  end if;
  return v_n;
end;
$$;

create or replace function private.client_wait_close(p_wait uuid, p_returned date, p_source text, p_note text) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  v_ret date;
  v_n int;
begin
  select * into w from public.client_waits where id = p_wait for update;
  if w.id is null or w.closed_at is not null then return 0; end if;
  v_ret := greatest(least(coalesce(p_returned, private.today_br()), private.today_br()), w.started_on);
  update public.client_waits set returned_on = v_ret, returned_by = private.current_profile_id(),
    returned_note = nullif(trim(coalesce(p_note, '')), ''), close_source = p_source, closed_at = now()
  where id = w.id;
  -- Dias empurrados a partir do dia do retorno real voltam.
  v_n := private.client_wait_refund(w.id, v_ret - 1, null,
           'Retorno do cliente em ' || to_char(v_ret, 'DD/MM') || ': dias devolvidos ao cronograma');
  perform private.resolve_notifications('client_wait_late', w.id);
  perform private.resolve_notifications('client_wait_reminder', w.id);
  return v_n;
end;
$$;

-- Gatilhos: Entregas
create or replace function private.client_wait_on_version() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare d public.project_deliveries;
begin
  if new.published_at is not null and old.published_at is null and new.kind in ('presentation', 'revision') then
    select * into d from public.project_deliveries where id = new.delivery_id;
    if d.revisions_enabled then
      perform private.client_wait_open(new.project_id, 'delivery', d.id, new.id, null,
        'Avaliação: ' || new.title || ' · ' || private.delivery_service_name(d));
    end if;
  end if;
  return new;
end;
$$;
create trigger delivery_versions_client_wait after update of published_at on public.delivery_versions
  for each row execute function private.client_wait_on_version();

create or replace function private.client_wait_on_request() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare w uuid;
begin
  select id into w from public.client_waits where delivery_id = new.delivery_id and closed_at is null;
  if w is not null then
    perform private.client_wait_close(w, (new.created_at at time zone 'America/Sao_Paulo')::date,
      case when new.on_behalf then 'team' else 'portal' end, null);
  end if;
  return new;
end;
$$;
create trigger delivery_revision_requests_client_wait after insert on public.delivery_revision_requests
  for each row execute function private.client_wait_on_request();

create or replace function private.client_wait_on_approval() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare w uuid;
begin
  if new.creation_approved_at is not null and old.creation_approved_at is null then
    select id into w from public.client_waits where delivery_id = new.id and closed_at is null;
    if w is not null then
      perform private.client_wait_close(w, (new.creation_approved_at at time zone 'America/Sao_Paulo')::date,
        case when new.approval_on_behalf then 'team' else 'portal' end, null);
    end if;
  end if;
  return new;
end;
$$;
create trigger project_deliveries_client_wait after update of creation_approved_at on public.project_deliveries
  for each row execute function private.client_wait_on_approval();

-- Gatilho: etapa "Aguardando cliente"
create or replace function private.client_wait_on_task() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare w uuid;
begin
  if new.status = 'waiting_client' and old.status is distinct from 'waiting_client' then
    perform private.client_wait_open(new.project_id, 'task', null, null, new.id,
      case when new.client_visible then new.name else 'Retorno sobre o projeto' end);
  elsif old.status = 'waiting_client' and new.status is distinct from 'waiting_client' then
    select id into w from public.client_waits where task_id = new.id and closed_at is null;
    if w is not null then
      perform private.client_wait_close(w, private.today_br(), case when new.status = 'cancelled' then 'cancelled' else 'status' end, null);
    end if;
  end if;
  return new;
end;
$$;
create trigger project_tasks_client_wait after update of status on public.project_tasks
  for each row execute function private.client_wait_on_task();

-- -----------------------------------------------------------------------------
-- Empurrão de 1 dia útil por dia de atraso
-- -----------------------------------------------------------------------------
-- Etapa de referência: a da espera (manual) ou a etapa atual do serviço da entrega.
create or replace function private.client_wait_anchor(w public.client_waits) returns public.project_tasks
language plpgsql stable security definer set search_path = ''
as $$
declare a public.project_tasks;
begin
  if w.source = 'task' then
    select * into a from public.project_tasks where id = w.task_id and status not in ('completed', 'cancelled');
    return a;
  end if;
  select t.* into a from public.project_tasks t
    join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
    join public.project_deliveries d on d.project_service_id = tr.project_service_id
   where d.id = w.delivery_id and t.status not in ('completed', 'cancelled')
   order by (t.actual_start_date is null), t.sequence
   limit 1;
  return a;
end;
$$;

-- Sem etapa de referência: as primeiras etapas não iniciadas de cada corrente andam 1 dia.
create or replace function private.client_wait_push_all(p_project uuid, p_cal uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_map jsonb := '{}'::jsonb;
  r record;
begin
  for r in
    with cand as (
      select pt.id, pt.planned_start_date, pt.start_not_before
      from public.project_tasks pt
      where pt.project_id = p_project and pt.actual_start_date is null
        and pt.status not in ('completed', 'cancelled') and pt.planned_start_date is not null
    ),
    below(id) as (
      select d.task_id from public.task_dependencies d join cand c on d.depends_on_task_id = c.id
      union
      select d.task_id from public.task_dependencies d join below b on d.depends_on_task_id = b.id
    )
    select c.* from cand c where c.id not in (select id from below)
  loop
    v_map := v_map || jsonb_build_object(r.id::text, jsonb_build_object('start',
      greatest(coalesce(r.start_not_before, r.planned_start_date), public.add_business_days(r.planned_start_date, 2, p_cal))));
  end loop;
  return v_map;
end;
$$;

create or replace function private.client_wait_push(p_wait uuid, p_day date) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  a public.project_tasks;
  rep public.project_tasks;
  rep2 public.project_tasks;
  cal uuid;
  ov jsonb;
  v_map jsonb;
  v_details jsonb := '[]'::jsonb;
  v_before date;
  v_after date;
  v_ids uuid[];
  v_change uuid;
  v_reason uuid;
  k text;
begin
  select * into w from public.client_waits where id = p_wait;
  if exists (select 1 from public.client_wait_pushes where project_id = w.project_id and day = p_day and refunded_at is null) then return false; end if;
  cal := private.client_wait_cal(w.project_id);
  a := private.client_wait_anchor(w);

  if a.id is not null and a.actual_start_date is not null and a.duration_type in ('fixed', 'external') and a.planned_duration_days is not null then
    ov := jsonb_build_object('duration', a.planned_duration_days + 1);
  elsif a.id is not null and a.actual_start_date is null and a.planned_start_date is not null then
    ov := jsonb_build_object('start', public.add_business_days(a.planned_start_date, 2, cal));
  else
    a := null;
  end if;

  if a.id is not null then
    v_map := private.delay_cascade_overrides(a.id, ov);
    rep := a;
  else
    v_map := private.client_wait_push_all(w.project_id, cal);
    select t.* into rep from public.project_tasks t where t.id::text in (select jsonb_object_keys(v_map))
      order by t.client_visible desc, t.planned_start_date limit 1;
  end if;
  if rep.id is null then return false; end if;  -- nada a empurrar

  perform private.engine_on();
  if a.id is not null then
    if ov ? 'duration' then
      v_details := v_details || jsonb_build_array(jsonb_build_object('id', a.id, 'f', 'dur', 'b', a.planned_duration_days, 'a', a.planned_duration_days + 1));
      update public.project_tasks set planned_duration_days = a.planned_duration_days + 1 where id = a.id;
    else
      v_details := v_details || jsonb_build_array(jsonb_build_object('id', a.id, 'f', 'snb', 'b', a.start_not_before, 'a', ov ->> 'start'));
      update public.project_tasks set start_not_before = (ov ->> 'start')::date where id = a.id;
    end if;
  end if;
  for k in select jsonb_object_keys(v_map - '_delay_days' - coalesce(a.id::text, '')) loop
    select start_not_before into v_before from public.project_tasks where id = k::uuid and project_id = w.project_id;
    v_after := (v_map -> k ->> 'start')::date;
    if v_after is not null and v_before is distinct from v_after then
      v_details := v_details || jsonb_build_array(jsonb_build_object('id', k, 'f', 'snb', 'b', v_before, 'a', v_after));
      update public.project_tasks set start_not_before = v_after where id = k::uuid and project_id = w.project_id;
    end if;
  end loop;

  v_ids := private.apply_schedule(w.project_id);
  select * into rep2 from public.project_tasks where id = rep.id;
  select id into v_reason from public.schedule_change_reasons where label = 'Aguardando aprovação ou retorno do cliente' limit 1;
  insert into public.task_changes (project_id, task_id, change_type, before, after, reason, reason_id, impacted_task_ids, changed_by)
  values (w.project_id, rep.id, 'reschedule', private.task_snapshot(rep), private.task_snapshot(rep2) || jsonb_build_object('delay_days', 1),
          'Aguardando aprovação ou retorno do cliente · sem retorno desde ' || to_char(w.started_on, 'DD/MM') || ' (prazo ' || to_char(w.due_on, 'DD/MM') || ')',
          v_reason, array_remove(v_ids, rep.id), null)
  returning id into v_change;
  insert into public.client_wait_pushes (project_id, day, wait_id, anchor_task_id, change_id, details)
  values (w.project_id, p_day, w.id, rep.id, v_change, v_details);
  return true;
end;
$$;

-- Rotina (pg_cron, a cada hora): empurra dias vencidos, lembra o cliente no último dia e avisa o primeiro atraso.
create or replace function private.client_wait_run(p_today date default null) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_today date := coalesce(p_today, private.today_br());
  v_hour int := extract(hour from now() at time zone 'America/Sao_Paulo')::int;
  w public.client_waits;
  p public.projects;
  cal uuid;
  d date;
  v_n int := 0;
  v_first boolean;
begin
  for w in select x.* from public.client_waits x join public.projects pj on pj.id = x.project_id
           where x.closed_at is null and pj.status = 'in_progress' order by x.started_on loop
    select * into p from public.projects where id = w.project_id;
    cal := private.calendar_for_tenant(p.delivery_tenant_id);

    -- Lembrete no último dia do prazo (a partir das 9h).
    if w.due_on = v_today and w.reminded_at is null and (p_today is not null or v_hour >= 9) then
      perform private.notify_project_clients(p.id, 'client_wait_reminder', 'Hoje é o prazo para o seu retorno',
        p.name || ' · ' || w.label || '. Sem o seu retorno, as próximas etapas do cronograma serão adiadas.',
        'client_waits', w.id, jsonb_build_object('project_id', p.id, 'source', w.source));
      update public.client_waits set reminded_at = now() where id = w.id;
    end if;

    -- Dias úteis completos depois do prazo (recupera no máximo 7 dias de rotina parada).
    v_first := not exists (select 1 from public.client_wait_pushes where wait_id = w.id);
    for d in select g::date from generate_series(greatest(w.due_on + 1, v_today - 7), v_today - 1, interval '1 day') g
             where private.is_business_day(g::date, cal) and (w.waived_until is null or g::date > w.waived_until) loop
      if private.client_wait_push(w.id, d) then v_n := v_n + 1; end if;
    end loop;

    if v_first and w.late_notified_at is null and exists (select 1 from public.client_wait_pushes where wait_id = w.id and refunded_at is null) then
      perform private.notify_project_clients(p.id, 'client_wait_late', 'Cronograma ajustado: aguardamos o seu retorno',
        p.name || ' · ' || w.label || '. Como o prazo de retorno passou, as próximas etapas foram adiadas. Responda para retomarmos.',
        'client_waits', w.id, jsonb_build_object('project_id', p.id, 'source', w.source));
      perform private.notify(p.delivery_tenant_id, 'client_wait_late', 'Cliente sem retorno: cronograma empurrado',
        p.name || ' · ' || w.label || ' · prazo era ' || to_char(w.due_on, 'DD/MM'), 'client_waits', w.id,
        jsonb_build_object('project_id', p.id), array['customer_success']::public.user_role[], null);
      perform private.notify_people(private.project_leaders(p.id, private.client_wait_ps(w)), p.delivery_tenant_id, 'client_wait_late',
        'Cliente sem retorno: cronograma empurrado', p.name || ' · ' || w.label, 'client_waits', w.id, jsonb_build_object('project_id', p.id));
      update public.client_waits set late_notified_at = now() where id = w.id;
    end if;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Ações da equipe
-- -----------------------------------------------------------------------------
create or replace function private.client_wait_return(p_wait uuid, p_date date, p_note text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  v_n int;
  t public.project_tasks;
begin
  select * into w from public.client_waits where id = p_wait;
  if w.id is null or not private.can_view_project(w.project_id) then raise exception 'Espera não encontrada' using errcode = 'P0002'; end if;
  if not private.can_return_wait(w) then
    raise exception 'Somente o responsável e os líderes do projeto registram o retorno do cliente' using errcode = '42501';
  end if;
  if w.closed_at is not null then raise exception 'Este retorno já foi registrado' using errcode = '23514'; end if;
  if p_date is not null and (p_date > private.today_br() or p_date < w.started_on) then
    raise exception 'A data do retorno deve estar entre % e hoje', to_char(w.started_on, 'DD/MM/YYYY') using errcode = '23514';
  end if;
  v_n := private.client_wait_close(w.id, p_date, 'team', p_note);
  -- A etapa que aguardava o cliente volta para "Em andamento".
  if w.source = 'task' then
    select * into t from public.project_tasks where id = w.task_id;
    if t.status = 'waiting_client' then
      perform private.engine_on();
      update public.project_tasks set status = 'in_progress', waiting_reason = null where id = t.id;
      perform private.apply_schedule(t.project_id);
    end if;
  end if;
  return jsonb_build_object('refunded_days', v_n);
end;
$$;

create or replace function private.client_wait_waive(p_wait uuid, p_until date, p_reason text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  v_n int;
begin
  select * into w from public.client_waits where id = p_wait for update;
  if w.id is null or not private.can_view_project(w.project_id) then raise exception 'Espera não encontrada' using errcode = 'P0002'; end if;
  if not private.can_waive_wait(w) then raise exception 'Somente o líder da área ou a administração abona dias' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Explique o motivo do abono' using errcode = '23514'; end if;
  if p_until is null or p_until <= w.due_on then raise exception 'Abone até uma data depois do prazo (%)', to_char(w.due_on, 'DD/MM') using errcode = '23514'; end if;
  if p_until > private.today_br() + 60 then raise exception 'Abono de no máximo 60 dias' using errcode = '23514'; end if;
  update public.client_waits set waived_until = greatest(coalesce(waived_until, p_until), p_until), waive_reason = trim(p_reason),
    waived_by = private.current_profile_id(), waived_at = now()
  where id = w.id;
  v_n := private.client_wait_refund(w.id, null, p_until, 'Dias abonados pela liderança: ' || trim(p_reason));
  perform private.log_audit('client_wait_waived', 'client_waits', w.id, w.tenant_id, jsonb_build_object('until', p_until, 'refunded', v_n));
  return jsonb_build_object('refunded_days', v_n);
end;
$$;

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
create or replace function private.client_wait_json(w public.client_waits, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', w.id, 'project_id', w.project_id, 'source', w.source, 'label', w.label,
    'project_service_id', private.client_wait_ps(w), 'task_id', w.task_id,
    'started_on', w.started_on, 'due_on', w.due_on, 'returned_on', w.returned_on, 'close_source', w.close_source,
    'state', case when w.closed_at is not null then 'closed' when private.today_br() > w.due_on then 'late' else 'open' end,
    'late_days', (select count(*) from public.client_wait_pushes x where x.wait_id = w.id and x.refunded_at is null),
    'waived_until', w.waived_until,
    'waive_reason', case when p_staff then w.waive_reason end,
    'returned_note', case when p_staff then w.returned_note end,
    'returned_by', case when p_staff then (select x.name from public.profiles x where x.id = w.returned_by) end,
    'can_return', p_staff and w.closed_at is null and private.can_return_wait(w),
    'can_waive', p_staff and w.closed_at is null and private.can_waive_wait(w))
$$;

create or replace function private.project_client_waits(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  v_staff boolean := private.is_staff();
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'days', (select r.days from private.client_wait_rules(p.delivery_tenant_id) r),
    'enabled', (select r.enabled from private.client_wait_rules(p.delivery_tenant_id) r),
    'total_late_days', (select count(*) from public.client_wait_pushes x where x.project_id = p.id and x.refunded_at is null),
    'waits', (select coalesce(jsonb_agg(private.client_wait_json(w, v_staff) order by (w.closed_at is null) desc, w.started_on desc), '[]'::jsonb)
              from public.client_waits w where w.project_id = p.id
                and (w.closed_at is null or w.closed_at > now() - interval '60 days')
                and w.close_source is distinct from 'cancelled'));
end;
$$;

-- Cliente: esperas abertas dos seus projetos.
create or replace function private.my_client_waits() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.my_role() is distinct from 'client' then return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(private.client_wait_json(w, false) || jsonb_build_object('project_name', p.name) order by w.due_on), '[]'::jsonb)
          from public.client_waits w join public.projects p on p.id = w.project_id
          where w.closed_at is null and private.can_view_project(p.id));
end;
$$;

-- CS e gestão: esperas abertas nos projetos visíveis.
create or replace function private.client_waits_overview() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.is_cs() or private.is_manager()) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(private.client_wait_json(w, true) || jsonb_build_object('project_name', p.name, 'project_code', p.code,
            'client_name', (select c.name from public.clients c where c.id = p.client_id))
            order by w.due_on), '[]'::jsonb)
          from public.client_waits w join public.projects p on p.id = w.project_id
          where w.closed_at is null and p.status = 'in_progress' and private.can_view_project(p.id));
end;
$$;

create or replace function private.client_wait_settings_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r record;
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  select * into r from private.client_wait_rules(p_tenant);
  return jsonb_build_object('tenant_id', p_tenant, 'enabled', r.enabled, 'days', r.days);
end;
$$;

create or replace function private.client_wait_settings_save(p_tenant uuid, p_enabled boolean, p_days int) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Somente a administração altera o prazo' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 15 then raise exception 'Prazo de 1 a 15 dias úteis' using errcode = '23514'; end if;
  insert into public.client_wait_settings (tenant_id, enabled, days, updated_by, updated_at)
  values (p_tenant, coalesce(p_enabled, true), p_days, private.current_profile_id(), now())
  on conflict (tenant_id) do update set enabled = excluded.enabled, days = excluded.days, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers, permissões e rotina
-- -----------------------------------------------------------------------------
create or replace function public.project_client_waits(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_client_waits(p_project) $$;
create or replace function public.my_client_waits() returns jsonb
language sql security invoker set search_path = '' as $$ select private.my_client_waits() $$;
create or replace function public.client_waits_overview() returns jsonb
language sql security invoker set search_path = '' as $$ select private.client_waits_overview() $$;
create or replace function public.client_wait_return(p_wait uuid, p_date date, p_note text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.client_wait_return(p_wait, p_date, p_note) $$;
create or replace function public.client_wait_waive(p_wait uuid, p_until date, p_reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.client_wait_waive(p_wait, p_until, p_reason) $$;
create or replace function public.client_wait_settings_get(p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.client_wait_settings_get(p_tenant) $$;
create or replace function public.client_wait_settings_save(p_tenant uuid, p_enabled boolean, p_days int) returns void
language sql security invoker set search_path = '' as $$ select private.client_wait_settings_save(p_tenant, p_enabled, p_days) $$;

revoke all on function
  private.client_wait_rules(uuid), private.client_wait_cal(uuid), private.client_wait_ps(public.client_waits), private.prev_business_day(date, uuid),
  private.can_return_wait(public.client_waits), private.can_waive_wait(public.client_waits), private.client_wait_covers(public.client_waits, date),
  private.client_wait_open(uuid, text, uuid, uuid, uuid, text), private.client_wait_refund(uuid, date, date, text),
  private.client_wait_close(uuid, date, text, text), private.client_wait_anchor(public.client_waits), private.client_wait_push_all(uuid, uuid),
  private.client_wait_push(uuid, date), private.client_wait_run(date), private.client_wait_return(uuid, date, text),
  private.client_wait_waive(uuid, date, text), private.client_wait_json(public.client_waits, boolean), private.project_client_waits(uuid),
  private.my_client_waits(), private.client_waits_overview(), private.client_wait_settings_get(uuid), private.client_wait_settings_save(uuid, boolean, int),
  public.project_client_waits(uuid), public.my_client_waits(), public.client_waits_overview(), public.client_wait_return(uuid, date, text),
  public.client_wait_waive(uuid, date, text), public.client_wait_settings_get(uuid), public.client_wait_settings_save(uuid, boolean, int)
from public, anon;

grant execute on function
  private.client_wait_rules(uuid), private.client_wait_cal(uuid), private.client_wait_ps(public.client_waits), private.prev_business_day(date, uuid),
  private.can_return_wait(public.client_waits), private.can_waive_wait(public.client_waits), private.client_wait_covers(public.client_waits, date),
  private.client_wait_open(uuid, text, uuid, uuid, uuid, text), private.client_wait_refund(uuid, date, date, text),
  private.client_wait_close(uuid, date, text, text), private.client_wait_anchor(public.client_waits),
  private.client_wait_return(uuid, date, text), private.client_wait_waive(uuid, date, text), private.client_wait_json(public.client_waits, boolean),
  private.project_client_waits(uuid), private.my_client_waits(), private.client_waits_overview(),
  private.client_wait_settings_get(uuid), private.client_wait_settings_save(uuid, boolean, int),
  public.project_client_waits(uuid), public.my_client_waits(), public.client_waits_overview(), public.client_wait_return(uuid, date, text),
  public.client_wait_waive(uuid, date, text), public.client_wait_settings_get(uuid), public.client_wait_settings_save(uuid, boolean, int)
to authenticated;
-- A rotina e o empurrão só rodam pelo agendador (dono das funções).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('youcon-client-wait', '17 * * * *', 'select private.client_wait_run()');
  end if;
end $$;
