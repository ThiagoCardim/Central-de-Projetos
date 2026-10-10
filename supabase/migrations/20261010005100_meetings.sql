-- =============================================================================
-- 0051 · Agenda de reuniões com o cliente (Google Meet)
--
--   Cada pessoa da equipe define a própria disponibilidade (horários por dia da
--   semana + bloqueios). Os horários livres também descontam o que estiver
--   ocupado no Google Calendar dela (o "livre/ocupado" é trazido pela Edge
--   Function `meetings` e guardado em meeting_busy).
--   O cliente agenda pelo portal; a equipe agenda pelo projeto ou compartilha um
--   link público (/agendar/<token>) para o cliente escolher o horário sem login.
--   A reunião é criada pela conta central do Google (Meet + Calendar): a
--   transcrição vem ligada; a gravação é opcional. Depois da reunião, os links da
--   transcrição e da gravação (Drive) são anexados à reunião no projeto.
--   As credenciais do Google ficam no schema private (fora da API).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Configurações por unidade
-- -----------------------------------------------------------------------------
create table public.meeting_settings (
  tenant_id            uuid primary key references public.tenants (id),
  alignment_minutes    int not null default 60 check (alignment_minutes between 15 and 240),
  presentation_minutes int not null default 60 check (presentation_minutes between 15 and 240),
  min_notice_hours     int not null default 24 check (min_notice_hours between 0 and 336),
  horizon_days         int not null default 30 check (horizon_days between 1 and 120),
  buffer_minutes       int not null default 15 check (buffer_minutes between 0 and 120),
  slot_step_minutes    int not null default 30 check (slot_step_minutes in (15, 30, 60)),
  share_with_client    boolean not null default false,
  updated_by           uuid references public.profiles (id) on delete set null,
  updated_at           timestamptz not null default now()
);
alter table public.meeting_settings enable row level security;
revoke all on public.meeting_settings from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Disponibilidade de cada pessoa
-- -----------------------------------------------------------------------------
create table public.meeting_hosts (
  profile_id uuid primary key references public.profiles (id),
  bookable   boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.availability_rules (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  weekday    int not null check (weekday between 0 and 6),   -- 0 = domingo
  start_time time not null,
  end_time   time not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint availability_rules_range_chk check (end_time > start_time)
);
create index availability_rules_profile_idx on public.availability_rules (profile_id, weekday) where active;

create table public.availability_blocks (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  reason     text check (reason is null or length(reason) <= 200),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint availability_blocks_range_chk check (ends_at > starts_at)
);
create index availability_blocks_profile_idx on public.availability_blocks (profile_id, starts_at) where active;

-- Ocupado no Google Calendar (por dia, para não precisar apagar linhas).
create table public.meeting_busy (
  profile_id uuid not null references public.profiles (id),
  day        date not null,
  intervals  jsonb not null default '[]'::jsonb,   -- [{"s": timestamptz, "e": timestamptz}]
  fetched_at timestamptz not null default now(),
  primary key (profile_id, day)
);

-- -----------------------------------------------------------------------------
-- Reuniões e links de agendamento
-- -----------------------------------------------------------------------------
create table public.meetings (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id),
  tenant_id        uuid references public.tenants (id),
  kind             text not null check (kind in ('alignment', 'presentation')),
  task_id          uuid references public.project_tasks (id),
  title            text not null check (length(trim(title)) between 2 and 160),
  notes            text check (notes is null or length(notes) <= 2000),
  host_profile_id  uuid not null references public.profiles (id),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  status           text not null default 'scheduled' check (status in ('scheduled', 'cancelled')),
  booked_by        uuid references public.profiles (id),
  booked_via       text not null check (booked_via in ('portal', 'team', 'link')),
  guest_name       text check (guest_name is null or length(guest_name) <= 120),
  guest_email      text check (guest_email is null or length(guest_email) <= 200),
  guest_phone      text check (guest_phone is null or length(guest_phone) <= 40),
  attendees        jsonb not null default '[]'::jsonb,       -- [{"email","name"}]
  record           boolean not null default false,
  transcribe       boolean not null default true,
  meet_uri         text,
  meet_code        text,
  meet_space       text,
  calendar_event_id text,
  google_status    text not null default 'pending' check (google_status in ('pending', 'created', 'failed', 'not_connected', 'manual')),
  google_error     text,
  transcript_url   text,
  recording_url    text,
  artifacts_status text not null default 'waiting' check (artifacts_status in ('waiting', 'partial', 'done', 'none')),
  artifacts_checked_at timestamptz,
  cancelled_at     timestamptz,
  cancelled_by     uuid references public.profiles (id),
  cancel_reason    text check (cancel_reason is null or length(cancel_reason) <= 500),
  link_id          uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint meetings_range_chk check (ends_at > starts_at)
);
create index meetings_project_idx on public.meetings (project_id, starts_at desc);
create index meetings_host_idx on public.meetings (host_profile_id, starts_at) where status = 'scheduled';
create trigger meetings_touch before update on public.meetings for each row execute function private.touch_updated_at();

create table public.meeting_links (
  id              uuid primary key default gen_random_uuid(),
  token           text not null unique,
  project_id      uuid not null references public.projects (id),
  host_profile_id uuid not null references public.profiles (id),
  kind            text not null check (kind in ('alignment', 'presentation')),
  task_id         uuid references public.project_tasks (id),
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  single_use      boolean not null default true,
  used_at         timestamptz,
  active          boolean not null default true
);
create index meeting_links_project_idx on public.meeting_links (project_id, created_at desc);

alter table public.meeting_hosts enable row level security;
alter table public.availability_rules enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.meeting_busy enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_links enable row level security;
revoke all on public.meeting_hosts, public.availability_rules, public.availability_blocks, public.meeting_busy,
  public.meetings, public.meeting_links from anon, authenticated;
create trigger meetings_audit after insert or update on public.meetings for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Conta central do Google (somente a Edge Function lê o token)
-- -----------------------------------------------------------------------------
create table private.google_account (
  id             int primary key default 1 check (id = 1),
  email          text,
  domain         text,
  refresh_token  text,
  scopes         text,
  root_folder_id text,
  status         text not null default 'disconnected' check (status in ('connected', 'error', 'disconnected')),
  last_error     text,
  connected_by   uuid references public.profiles (id) on delete set null,
  connected_at   timestamptz,
  updated_at     timestamptz not null default now()
);
create table private.google_oauth_states (
  state      text primary key,
  profile_id uuid not null references public.profiles (id),
  return_to  text,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create table private.google_project_folders (
  project_id uuid primary key references public.projects (id),
  folder_id  text not null,
  created_at timestamptz not null default now()
);
revoke all on private.google_account, private.google_oauth_states, private.google_project_folders from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Regras e cálculo de horários
-- -----------------------------------------------------------------------------
create or replace function private.meeting_rules(p_tenant uuid)
returns table (alignment_minutes int, presentation_minutes int, min_notice_hours int, horizon_days int,
               buffer_minutes int, slot_step_minutes int, share_with_client boolean)
language sql stable security definer set search_path = ''
as $$
  select coalesce(s.alignment_minutes, 60), coalesce(s.presentation_minutes, 60), coalesce(s.min_notice_hours, 24),
         coalesce(s.horizon_days, 30), coalesce(s.buffer_minutes, 15), coalesce(s.slot_step_minutes, 30),
         coalesce(s.share_with_client, false)
  from (select 1) one left join public.meeting_settings s on s.tenant_id = p_tenant
$$;

create or replace function private.meeting_minutes(p_tenant uuid, p_kind text) returns int
language sql stable security definer set search_path = ''
as $$ select case when p_kind = 'presentation' then r.presentation_minutes else r.alignment_minutes end from private.meeting_rules(p_tenant) r $$;

create or replace function private.meeting_kind_label(p_kind text) returns text
language sql immutable set search_path = ''
as $$ select case when p_kind = 'presentation' then 'Apresentação de etapa' else 'Reunião de alinhamento' end $$;

-- Feriado no calendário da unidade (o dia da semana vem da disponibilidade da pessoa).
create or replace function private.is_holiday(p_date date, p_calendar uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.holidays h
                 where h.calendar_id = p_calendar
                   and (h.date = p_date or (h.recurring and extract(month from h.date) = extract(month from p_date)
                                                         and extract(day from h.date) = extract(day from p_date))))
$$;

-- Equipe do projeto que pode receber reuniões (liderança, colaboradores e responsáveis pelos serviços).
create or replace function private.project_hosts(p_project uuid) returns table (profile_id uuid)
language sql stable security definer set search_path = ''
as $$
  select distinct x.id from (
    select t.user_id id from public.project_team t where t.project_id = p_project and t.active
    union select ps.responsible_user_id from public.project_services ps
     where ps.project_id = p_project and ps.active and ps.responsible_user_id is not null) x
  join public.profiles pr on pr.id = x.id
  where pr.status = 'ativo' and pr.role in ('collaborator', 'leader', 'unit_admin', 'global_admin')
    and coalesce((select h.bookable from public.meeting_hosts h where h.profile_id = pr.id), true)
    and exists (select 1 from public.availability_rules r where r.profile_id = pr.id and r.active)
$$;

-- Horários livres da pessoa para uma reunião de p_minutes.
create or replace function private.meeting_slots(p_host uuid, p_minutes int, p_ignore_notice boolean default false)
returns table (starts_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  pr public.profiles;
  r record;
  cal uuid;
  d date;
  v_today date := private.today_br();
  rule record;
  t time;
  st timestamptz;
  en timestamptz;
begin
  select * into pr from public.profiles where id = p_host;
  if pr.id is null then return; end if;
  select * into r from private.meeting_rules(pr.tenant_id);
  cal := private.calendar_for_tenant(pr.tenant_id);
  for d in select g::date from generate_series(v_today, v_today + r.horizon_days, interval '1 day') g loop
    continue when private.is_holiday(d, cal);
    for rule in select ar.start_time, ar.end_time from public.availability_rules ar
                where ar.profile_id = p_host and ar.active and ar.weekday = extract(dow from d)::int
                order by ar.start_time loop
      t := rule.start_time;
      loop
        exit when t + make_interval(mins => p_minutes) > rule.end_time or t + make_interval(mins => p_minutes) <= t;
        st := (d + t) at time zone 'America/Sao_Paulo';
        en := st + make_interval(mins => p_minutes);
        if (p_ignore_notice or st >= now() + make_interval(hours => r.min_notice_hours)) and st > now()
           and not exists (select 1 from public.meetings m
                           where m.host_profile_id = p_host and m.status = 'scheduled'
                             and tstzrange(m.starts_at - make_interval(mins => r.buffer_minutes), m.ends_at + make_interval(mins => r.buffer_minutes))
                                 && tstzrange(st, en))
           and not exists (select 1 from public.availability_blocks b
                           where b.profile_id = p_host and b.active and tstzrange(b.starts_at, b.ends_at) && tstzrange(st, en))
           and not exists (select 1 from public.meeting_busy mb cross join lateral jsonb_array_elements(mb.intervals) i
                           where mb.profile_id = p_host and mb.day between d - 1 and d + 1
                             and tstzrange((i ->> 's')::timestamptz, (i ->> 'e')::timestamptz) && tstzrange(st, en)) then
          starts_at := st;
          return next;
        end if;
        exit when t + make_interval(mins => r.slot_step_minutes) <= t;   -- passaria da meia-noite
        t := t + make_interval(mins => r.slot_step_minutes);
      end loop;
    end loop;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Permissões
-- -----------------------------------------------------------------------------
-- Equipe que agenda pelo projeto: quem trabalha nele, a gestão e o CS.
create or replace function private.can_schedule_project(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_view_project(p_project) and (
    private.my_role() = 'client'
    or private.can_work_delivery(p_project) or private.can_manage_project(p_project) or private.is_cs())
$$;

-- -----------------------------------------------------------------------------
-- Agendar (núcleo, sem checagem de permissão: quem chama já validou)
-- -----------------------------------------------------------------------------
create or replace function private.meeting_book_core(p_project uuid, p_host uuid, p_kind text, p_starts timestamptz, p_task uuid,
  p_notes text, p_record boolean, p_via text, p_booked_by uuid, p_guest_name text, p_guest_email text, p_guest_phone text,
  p_link uuid, p_ignore_notice boolean default false)
returns public.meetings
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  h public.profiles;
  t public.project_tasks;
  m public.meetings;
  v_min int;
  v_att jsonb;
  v_title text;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or p.status in ('cancelled', 'completed') then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if p_kind not in ('alignment', 'presentation') then raise exception 'Tipo de reunião inválido' using errcode = '23514'; end if;
  if not exists (select 1 from private.project_hosts(p.id) x where x.profile_id = p_host) then
    raise exception 'Esta pessoa não recebe reuniões deste projeto' using errcode = '23514';
  end if;
  select * into h from public.profiles where id = p_host;
  if p_task is not null then
    select * into t from public.project_tasks where id = p_task and project_id = p.id and status <> 'cancelled';
    if t.id is null then raise exception 'Etapa não encontrada neste projeto' using errcode = 'P0002'; end if;
  end if;
  v_min := private.meeting_minutes(h.tenant_id, p_kind);

  -- Um agendamento por vez para a mesma pessoa.
  perform pg_advisory_xact_lock(hashtextextended(p_host::text, 51));
  if not exists (select 1 from private.meeting_slots(p_host, v_min, p_ignore_notice) s where s.starts_at = p_starts) then
    raise exception 'Este horário não está mais disponível. Escolha outro.' using errcode = '23505';
  end if;

  v_title := case when p_kind = 'presentation' then 'Apresentação' || coalesce(' · ' || t.name, ' de etapa') else 'Reunião de alinhamento' end
             || ' · ' || p.name;
  -- Convidados: quem recebe, quem agendou (cliente ou convidado do link) e, se a equipe agendou, os clientes que decidem.
  v_att := (select coalesce(jsonb_agg(distinct jsonb_build_object('email', lower(x.email), 'name', x.name)), '[]'::jsonb)
            from (select h.email::text email, h.name
                  union all select pr.email::text, pr.name from public.profiles pr where pr.id = p_booked_by
                  union all select p_guest_email, p_guest_name where nullif(trim(coalesce(p_guest_email, '')), '') is not null
                  union all select pr.email::text, pr.name from public.client_contacts cc join public.profiles pr on pr.id = cc.profile_id
                   where p_via = 'team' and cc.client_id = p.client_id and cc.can_decide and pr.status = 'ativo'
                     and private.client_contact_covers(cc, p.id)) x
            where x.email is not null);

  insert into public.meetings (project_id, tenant_id, kind, task_id, title, notes, host_profile_id, starts_at, ends_at,
                               booked_by, booked_via, guest_name, guest_email, guest_phone, attendees, record, link_id)
  values (p.id, coalesce(p.delivery_tenant_id, p.commercial_tenant_id), p_kind, t.id, left(v_title, 160),
          nullif(left(trim(coalesce(p_notes, '')), 2000), ''), p_host, p_starts, p_starts + make_interval(mins => v_min),
          p_booked_by, p_via, nullif(left(trim(coalesce(p_guest_name, '')), 120), ''), nullif(lower(trim(coalesce(p_guest_email, ''))), ''),
          nullif(left(trim(coalesce(p_guest_phone, '')), 40), ''), v_att, coalesce(p_record, false), p_link)
  returning * into m;

  if p_booked_by is distinct from p_host then
    perform private.notify(m.tenant_id, 'meeting_booked', 'Nova reunião: ' || private.meeting_kind_label(p_kind),
      p.name || ' · ' || to_char(p_starts at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI'), 'meetings', m.id,
      jsonb_build_object('project_id', p.id), null, p_host);
  end if;
  if p_via = 'team' then
    perform private.notify_project_clients(p.id, 'meeting_scheduled', 'Reunião marcada: ' || private.meeting_kind_label(p_kind),
      p.name || ' · ' || to_char(p_starts at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI') || ' com ' || h.name,
      'meetings', m.id, jsonb_build_object('project_id', p.id));
  end if;
  perform private.log_audit('meeting_booked', 'meetings', m.id, m.tenant_id, jsonb_build_object('via', p_via, 'host', p_host));
  return m;
end;
$$;

-- -----------------------------------------------------------------------------
-- Portal (cliente ou equipe logados)
-- -----------------------------------------------------------------------------
create or replace function private.can_manage_meeting(m public.meetings) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_staff() and (m.host_profile_id = private.current_profile_id() or m.booked_by = private.current_profile_id()
    or private.can_manage_project(m.project_id) or private.current_profile_id() = any (private.project_leaders(m.project_id, null))
    or private.is_cs())
$$;

create or replace function private.can_cancel_meeting(m public.meetings) returns boolean
language sql stable security definer set search_path = ''
as $$
  select m.status = 'scheduled' and m.ends_at > now() and private.can_view_project(m.project_id)
     and (private.can_manage_meeting(m) or (private.my_role() = 'client' and (m.booked_by = private.current_profile_id() or private.client_decides(m.project_id))))
$$;

create or replace function private.meeting_json(m public.meetings, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', m.id, 'project_id', m.project_id,
    'project_name', (select p.name from public.projects p where p.id = m.project_id),
    'kind', m.kind, 'kind_label', private.meeting_kind_label(m.kind), 'title', m.title, 'notes', m.notes,
    'task', case when m.task_id is not null then (select jsonb_build_object('id', t.id, 'name', t.name) from public.project_tasks t where t.id = m.task_id) end,
    'host', (select jsonb_build_object('id', pr.id, 'name', pr.name, 'avatar_url', pr.avatar_url) from public.profiles pr where pr.id = m.host_profile_id),
    'starts_at', m.starts_at, 'ends_at', m.ends_at,
    'state', case when m.status = 'cancelled' then 'cancelled' when m.ends_at < now() then 'past'
                  when m.starts_at <= now() then 'live' else 'scheduled' end,
    'booked_via', m.booked_via,
    'booked_by', coalesce((select pr.name from public.profiles pr where pr.id = m.booked_by), m.guest_name),
    'guest', case when p_staff then jsonb_build_object('name', m.guest_name, 'email', m.guest_email, 'phone', m.guest_phone) end,
    'record', m.record, 'transcribe', m.transcribe,
    'meet_uri', case when m.status = 'scheduled' then m.meet_uri end,
    'google_status', m.google_status, 'google_error', case when p_staff then m.google_error end,
    'transcript_url', case when p_staff or (select r.share_with_client from private.meeting_rules(m.tenant_id) r) then m.transcript_url end,
    'recording_url', case when p_staff or (select r.share_with_client from private.meeting_rules(m.tenant_id) r) then m.recording_url end,
    'artifacts_status', m.artifacts_status,
    'cancel_reason', m.cancel_reason, 'cancelled_at', m.cancelled_at,
    'can_cancel', private.can_cancel_meeting(m),
    'can_manage', p_staff and private.can_manage_meeting(m))
$$;

-- Opções para agendar: tipos, pessoas da equipe e etapas que podem ser apresentadas.
create or replace function private.meeting_options(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  r record;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_schedule_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  select * into r from private.meeting_rules(coalesce(p.delivery_tenant_id, p.commercial_tenant_id));
  return jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status),
    'is_client', private.my_role() = 'client',
    'kinds', jsonb_build_array(
      jsonb_build_object('kind', 'alignment', 'label', 'Reunião de alinhamento', 'minutes', r.alignment_minutes),
      jsonb_build_object('kind', 'presentation', 'label', 'Apresentação de etapa', 'minutes', r.presentation_minutes)),
    'hosts', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name, 'avatar_url', pr.avatar_url,
                'role', coalesce(
                  (select string_agg(case t.project_role when 'lead_architecture' then 'Liderança de Arquitetura'
                            when 'lead_engineering' then 'Liderança de Engenharia' when 'lead_approval' then 'Liderança de Aprovação' end, ', ')
                     from public.project_team t where t.project_id = p.id and t.user_id = pr.id and t.active
                      and t.project_role in ('lead_architecture', 'lead_engineering', 'lead_approval')),
                  (select string_agg(s.name, ', ') from public.project_services ps join public.services s on s.id = ps.service_id
                    where ps.project_id = p.id and ps.responsible_user_id = pr.id and ps.active),
                  'Equipe do projeto'))
                order by pr.name), '[]'::jsonb)
              from private.project_hosts(p.id) x join public.profiles pr on pr.id = x.profile_id),
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name,
                'service', (select s.name from public.project_schedule_tracks tr join public.project_services ps on ps.id = tr.project_service_id
                            join public.services s on s.id = ps.service_id where tr.id = t.schedule_track_id))
                order by t.planned_start_date nulls last, t.sequence), '[]'::jsonb)
              from public.project_tasks t where t.project_id = p.id and t.status not in ('cancelled') and t.client_visible
                and t.cycle_kind is null),
    'can_record', private.my_role() <> 'client');
end;
$$;

-- Validação antes de buscar horários (a Edge Function usa o e-mail para o livre/ocupado do Google).
create or replace function private.meeting_slot_target(p_project uuid, p_host uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_schedule_project(p_project) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if not exists (select 1 from private.project_hosts(p_project) x where x.profile_id = p_host) then
    raise exception 'Esta pessoa não recebe reuniões deste projeto' using errcode = '23514';
  end if;
  return jsonb_build_object('host_id', p_host);
end;
$$;

create or replace function private.meeting_busy_target(p_host uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('host_id', h.id, 'email', h.email, 'from', private.today_br(),
    'to', private.today_br() + r.horizon_days,
    'fresh', coalesce((select min(b.fetched_at) > now() - interval '3 minutes' and count(*) > r.horizon_days
                       from public.meeting_busy b where b.profile_id = h.id and b.day between private.today_br() and private.today_br() + r.horizon_days), false))
  from public.profiles h cross join lateral private.meeting_rules(h.tenant_id) r where h.id = p_host
$$;

create or replace function private.meeting_slots_portal(p_project uuid, p_host uuid, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare h public.profiles;
begin
  perform private.meeting_slot_target(p_project, p_host);
  select * into h from public.profiles where id = p_host;
  return jsonb_build_object('minutes', private.meeting_minutes(h.tenant_id, p_kind),
    'slots', (select coalesce(jsonb_agg(s.starts_at order by s.starts_at), '[]'::jsonb)
              from private.meeting_slots(p_host, private.meeting_minutes(h.tenant_id, p_kind), private.my_role() <> 'client') s));
end;
$$;

create or replace function private.meeting_book_portal(p_project uuid, p_host uuid, p_kind text, p_starts timestamptz, p_task uuid,
                                                      p_notes text, p_record boolean) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  m public.meetings;
  v_client boolean := private.my_role() = 'client';
begin
  if not private.can_schedule_project(p_project) then
    raise exception 'Somente o cliente ou a equipe do projeto agendam reuniões' using errcode = '42501';
  end if;
  m := private.meeting_book_core(p_project, p_host, p_kind, p_starts, p_task, p_notes, case when v_client then false else p_record end,
         case when v_client then 'portal' else 'team' end, private.current_profile_id(), null, null, null, null, not v_client);
  return m.id;
end;
$$;

create or replace function private.project_meetings(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_staff boolean := private.is_staff();
begin
  if not private.can_view_project(p_project) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'can_schedule', private.can_schedule_project(p_project)
                    and exists (select 1 from public.projects p where p.id = p_project and p.status not in ('cancelled', 'completed')),
    'can_share_link', v_staff and private.can_schedule_project(p_project),
    'has_hosts', exists (select 1 from private.project_hosts(p_project)),
    'google', (select a.status from private.google_account a),
    'meetings', (select coalesce(jsonb_agg(private.meeting_json(m, v_staff)
                   order by (m.status = 'scheduled' and m.ends_at >= now()) desc,
                            case when m.status = 'scheduled' and m.ends_at >= now() then m.starts_at end asc,
                            m.starts_at desc), '[]'::jsonb)
                 from public.meetings m where m.project_id = p_project
                   and (m.status = 'scheduled' or m.cancelled_at > now() - interval '30 days')));
end;
$$;

-- Próximas reuniões: da pessoa (equipe) ou dos projetos do cliente.
create or replace function private.my_meetings() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_staff boolean := private.is_staff();
begin
  return (select coalesce(jsonb_agg(private.meeting_json(m, v_staff) order by m.starts_at), '[]'::jsonb)
          from public.meetings m
          where m.status = 'scheduled' and m.ends_at >= now() - interval '2 hours'
            and case when v_staff then m.host_profile_id = private.current_profile_id() or m.booked_by = private.current_profile_id()
                     else private.can_view_project(m.project_id) end);
end;
$$;

create or replace function private.meeting_cancel(p_meeting uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  m public.meetings;
  p public.projects;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.id is null or not private.can_view_project(m.project_id) then raise exception 'Reunião não encontrada' using errcode = 'P0002'; end if;
  if not private.can_cancel_meeting(m) then raise exception 'Você não pode cancelar esta reunião' using errcode = '42501'; end if;
  update public.meetings set status = 'cancelled', cancelled_at = now(), cancelled_by = private.current_profile_id(),
    cancel_reason = nullif(left(trim(coalesce(p_reason, '')), 500), '')
  where id = m.id;
  select * into p from public.projects where id = m.project_id;
  if private.current_profile_id() is distinct from m.host_profile_id then
    perform private.notify(m.tenant_id, 'meeting_cancelled', 'Reunião cancelada', p.name || ' · ' ||
      to_char(m.starts_at at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI'), 'meetings', m.id, jsonb_build_object('project_id', p.id), null, m.host_profile_id);
  end if;
  if private.my_role() <> 'client' then
    perform private.notify_project_clients(p.id, 'meeting_cancelled', 'Reunião cancelada', p.name || ' · ' ||
      to_char(m.starts_at at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI'), 'meetings', m.id, jsonb_build_object('project_id', p.id));
  end if;
  perform private.log_audit('meeting_cancelled', 'meetings', m.id, m.tenant_id, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('calendar_event_id', m.calendar_event_id);
end;
$$;

-- Gravação ligada/desligada antes de a reunião começar (a Edge Function ajusta o Meet).
create or replace function private.meeting_set_record(p_meeting uuid, p_record boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.id is null or not private.can_view_project(m.project_id) then raise exception 'Reunião não encontrada' using errcode = 'P0002'; end if;
  if not private.can_manage_meeting(m) then raise exception 'Somente a equipe da reunião altera a gravação' using errcode = '42501'; end if;
  if m.status <> 'scheduled' or m.ends_at < now() then raise exception 'A reunião já terminou' using errcode = '23514'; end if;
  update public.meetings set record = coalesce(p_record, false) where id = m.id;
  return jsonb_build_object('meet_space', m.meet_space, 'record', coalesce(p_record, false));
end;
$$;

-- Link da reunião informado à mão (sem conta Google conectada, ou outra ferramenta).
create or replace function private.meeting_set_link(p_meeting uuid, p_url text) returns void
language plpgsql security definer set search_path = ''
as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.id is null or not private.can_view_project(m.project_id) then raise exception 'Reunião não encontrada' using errcode = 'P0002'; end if;
  if not private.can_manage_meeting(m) then raise exception 'Somente a equipe da reunião altera o link' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_url, '')), '') is not null and trim(p_url) !~* '^https?://\S+$' then
    raise exception 'Link inválido: use um endereço completo, começando com https://' using errcode = '23514';
  end if;
  update public.meetings set meet_uri = nullif(trim(coalesce(p_url, '')), ''),
    google_status = case when google_status in ('not_connected', 'failed', 'manual') then 'manual' else google_status end
  where id = m.id;
end;
$$;

-- Transcrição e gravação registradas à mão (ex.: reunião em outra ferramenta).
create or replace function private.meeting_set_artifacts(p_meeting uuid, p_transcript text, p_recording text) returns void
language plpgsql security definer set search_path = ''
as $$
declare m public.meetings;
begin
  select * into m from public.meetings where id = p_meeting for update;
  if m.id is null or not private.can_view_project(m.project_id) then raise exception 'Reunião não encontrada' using errcode = 'P0002'; end if;
  if not private.can_manage_meeting(m) then raise exception 'Somente a equipe da reunião registra os arquivos' using errcode = '42501'; end if;
  if (nullif(trim(coalesce(p_transcript, '')), '') is not null and trim(p_transcript) !~* '^https?://\S+$')
     or (nullif(trim(coalesce(p_recording, '')), '') is not null and trim(p_recording) !~* '^https?://\S+$') then
    raise exception 'Link inválido: use um endereço completo, começando com https://' using errcode = '23514';
  end if;
  update public.meetings set transcript_url = nullif(trim(coalesce(p_transcript, '')), ''),
    recording_url = nullif(trim(coalesce(p_recording, '')), ''),
    artifacts_status = case when nullif(trim(coalesce(p_transcript, '')), '') is not null then 'done' else artifacts_status end
  where id = m.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Links públicos de agendamento
-- -----------------------------------------------------------------------------
create or replace function private.meeting_link_create(p_project uuid, p_host uuid, p_kind text, p_task uuid, p_days int) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text := replace(replace(rtrim(encode(extensions.gen_random_bytes(18), 'base64'), '='), '+', '-'), '/', '_');
  l public.meeting_links;
begin
  if not (private.is_staff() and private.can_schedule_project(p_project)) then
    raise exception 'Somente a equipe do projeto cria links de agendamento' using errcode = '42501';
  end if;
  if p_kind not in ('alignment', 'presentation') then raise exception 'Tipo de reunião inválido' using errcode = '23514'; end if;
  if not exists (select 1 from private.project_hosts(p_project) x where x.profile_id = p_host) then
    raise exception 'Esta pessoa não recebe reuniões deste projeto (defina os horários disponíveis em Agenda)' using errcode = '23514';
  end if;
  if p_task is not null and not exists (select 1 from public.project_tasks t where t.id = p_task and t.project_id = p_project) then
    raise exception 'Etapa não encontrada neste projeto' using errcode = 'P0002';
  end if;
  insert into public.meeting_links (token, project_id, host_profile_id, kind, task_id, created_by, expires_at)
  values (v_token, p_project, p_host, p_kind, p_task, private.current_profile_id(), now() + make_interval(days => least(greatest(coalesce(p_days, 14), 1), 60)))
  returning * into l;
  return jsonb_build_object('id', l.id, 'token', l.token, 'expires_at', l.expires_at);
end;
$$;

create or replace function private.meeting_link_row(p_token text) returns public.meeting_links
language plpgsql stable security definer set search_path = ''
as $$
declare l public.meeting_links;
begin
  select * into l from public.meeting_links where token = p_token;
  if l.id is null or not l.active then raise exception 'Link de agendamento não encontrado' using errcode = 'P0002'; end if;
  if l.expires_at < now() then raise exception 'Este link de agendamento expirou. Peça um novo à equipe.' using errcode = '23514'; end if;
  if l.single_use and l.used_at is not null then raise exception 'Este link já foi usado para marcar uma reunião.' using errcode = '23514'; end if;
  if not exists (select 1 from public.projects p where p.id = l.project_id and p.status not in ('cancelled', 'completed')) then
    raise exception 'Link de agendamento não encontrado' using errcode = 'P0002';
  end if;
  return l;
end;
$$;

-- Página pública: o mínimo para escolher o horário (sem e-mails nem dados internos).
create or replace function private.meeting_link_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  l public.meeting_links := private.meeting_link_row(p_token);
  h public.profiles;
begin
  select * into h from public.profiles where id = l.host_profile_id;
  return jsonb_build_object('project_name', (select p.name from public.projects p where p.id = l.project_id),
    'kind', l.kind, 'kind_label', private.meeting_kind_label(l.kind),
    'task_name', (select t.name from public.project_tasks t where t.id = l.task_id),
    'host', jsonb_build_object('name', h.name, 'avatar_url', h.avatar_url),
    'minutes', private.meeting_minutes(h.tenant_id, l.kind), 'expires_at', l.expires_at,
    'host_id', h.id);
end;
$$;

create or replace function private.meeting_link_slots(p_token text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  l public.meeting_links := private.meeting_link_row(p_token);
  h public.profiles;
begin
  select * into h from public.profiles where id = l.host_profile_id;
  return jsonb_build_object('minutes', private.meeting_minutes(h.tenant_id, l.kind),
    'slots', (select coalesce(jsonb_agg(s.starts_at order by s.starts_at), '[]'::jsonb)
              from private.meeting_slots(h.id, private.meeting_minutes(h.tenant_id, l.kind)) s));
end;
$$;

create or replace function private.meeting_link_book(p_token text, p_starts timestamptz, p_name text, p_email text, p_phone text, p_notes text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  l public.meeting_links := private.meeting_link_row(p_token);
  m public.meetings;
begin
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o seu nome' using errcode = '23514'; end if;
  if lower(trim(coalesce(p_email, ''))) !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Informe um e-mail válido' using errcode = '23514'; end if;
  select * into l from public.meeting_links where id = l.id for update;
  if l.single_use and l.used_at is not null then raise exception 'Este link já foi usado para marcar uma reunião.' using errcode = '23514'; end if;
  m := private.meeting_book_core(l.project_id, l.host_profile_id, l.kind, p_starts, l.task_id, p_notes, false, 'link', null,
         p_name, p_email, p_phone, l.id);
  update public.meeting_links set used_at = now() where id = l.id;
  if l.created_by is distinct from l.host_profile_id then perform private.notify(m.tenant_id, 'meeting_booked', 'Reunião marcada pelo link: ' || private.meeting_kind_label(l.kind),
    (select p.name from public.projects p where p.id = l.project_id) || ' · ' || trim(p_name) || ' · '
      || to_char(p_starts at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI'),
    'meetings', m.id, jsonb_build_object('project_id', l.project_id), null, l.created_by); end if;
  return m.id;
end;
$$;

create or replace function private.project_meeting_links(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.is_staff() and private.can_schedule_project(p_project)) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'token', l.token, 'kind', l.kind, 'kind_label', private.meeting_kind_label(l.kind),
            'host', (select pr.name from public.profiles pr where pr.id = l.host_profile_id),
            'task', (select t.name from public.project_tasks t where t.id = l.task_id),
            'created_by', (select pr.name from public.profiles pr where pr.id = l.created_by), 'created_at', l.created_at,
            'expires_at', l.expires_at, 'used_at', l.used_at,
            'state', case when not l.active then 'off' when l.used_at is not null and l.single_use then 'used'
                          when l.expires_at < now() then 'expired' else 'open' end)
            order by l.created_at desc), '[]'::jsonb)
          from public.meeting_links l where l.project_id = p_project and l.created_at > now() - interval '60 days');
end;
$$;

create or replace function private.meeting_link_disable(p_link uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare l public.meeting_links;
begin
  select * into l from public.meeting_links where id = p_link;
  if l.id is null or not (private.is_staff() and private.can_schedule_project(l.project_id)) then
    raise exception 'Link não encontrado' using errcode = 'P0002';
  end if;
  update public.meeting_links set active = false where id = l.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Minha disponibilidade
-- -----------------------------------------------------------------------------
create or replace function private.my_availability() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  r record;
begin
  if not private.is_staff() then raise exception 'Disponível para a equipe' using errcode = '42501'; end if;
  select * into r from private.meeting_rules(me.tenant_id);
  return jsonb_build_object(
    'bookable', coalesce((select h.bookable from public.meeting_hosts h where h.profile_id = me.id), true),
    'rules', (select coalesce(jsonb_agg(jsonb_build_object('weekday', a.weekday, 'start', to_char(a.start_time, 'HH24:MI'), 'end', to_char(a.end_time, 'HH24:MI'))
                order by a.weekday, a.start_time), '[]'::jsonb)
              from public.availability_rules a where a.profile_id = me.id and a.active),
    'blocks', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'reason', b.reason)
                 order by b.starts_at), '[]'::jsonb)
               from public.availability_blocks b where b.profile_id = me.id and b.active and b.ends_at > now()),
    'settings', jsonb_build_object('alignment_minutes', r.alignment_minutes, 'presentation_minutes', r.presentation_minutes,
                  'min_notice_hours', r.min_notice_hours, 'horizon_days', r.horizon_days, 'buffer_minutes', r.buffer_minutes),
    'google', (select a.status from private.google_account a),
    'upcoming', (select count(*) from public.meetings m where m.host_profile_id = me.id and m.status = 'scheduled' and m.ends_at > now()));
end;
$$;

-- Substitui a semana inteira: [{"weekday":1,"start":"09:00","end":"12:00"}, ...]
create or replace function private.availability_save(p_rules jsonb, p_bookable boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := private.current_profile_id();
  x jsonb;
  s time;
  e time;
begin
  if not private.is_staff() then raise exception 'Disponível para a equipe' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_rules, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_rules, '[]'::jsonb)) > 70 then
    raise exception 'Horários inválidos' using errcode = '23514';
  end if;
  for x in select * from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) loop
    begin
      s := (x ->> 'start')::time; e := (x ->> 'end')::time;
    exception when others then raise exception 'Horário inválido' using errcode = '23514';
    end;
    if (x ->> 'weekday')::int not between 0 and 6 or s is null or e is null or e <= s then
      raise exception 'Cada faixa precisa de início antes do fim' using errcode = '23514';
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) a
             join jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) b on (a ->> 'weekday') = (b ->> 'weekday') and a is distinct from b
             where (a ->> 'start')::time < (b ->> 'end')::time and (b ->> 'start')::time < (a ->> 'end')::time) then
    raise exception 'Há faixas de horário sobrepostas no mesmo dia' using errcode = '23514';
  end if;
  update public.availability_rules set active = false where profile_id = me and active;
  insert into public.availability_rules (profile_id, weekday, start_time, end_time)
  select me, (j ->> 'weekday')::int, (j ->> 'start')::time, (j ->> 'end')::time from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) j;
  insert into public.meeting_hosts (profile_id, bookable, updated_at) values (me, coalesce(p_bookable, true), now())
  on conflict (profile_id) do update set bookable = excluded.bookable, updated_at = now();
end;
$$;

create or replace function private.availability_block_add(p_starts timestamptz, p_ends timestamptz, p_reason text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not private.is_staff() then raise exception 'Disponível para a equipe' using errcode = '42501'; end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts then raise exception 'O fim precisa ser depois do início' using errcode = '23514'; end if;
  if p_ends > now() + interval '400 days' then raise exception 'Bloqueio de no máximo um ano' using errcode = '23514'; end if;
  insert into public.availability_blocks (profile_id, starts_at, ends_at, reason)
  values (private.current_profile_id(), p_starts, p_ends, nullif(left(trim(coalesce(p_reason, '')), 200), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.availability_block_remove(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.availability_blocks set active = false where id = p_id and profile_id = private.current_profile_id();
  if not found then raise exception 'Bloqueio não encontrado' using errcode = 'P0002'; end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Configurações (ADM) e conexão com o Google
-- -----------------------------------------------------------------------------
create or replace function private.meeting_settings_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r record;
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  select * into r from private.meeting_rules(p_tenant);
  return jsonb_build_object('tenant_id', p_tenant, 'alignment_minutes', r.alignment_minutes, 'presentation_minutes', r.presentation_minutes,
    'min_notice_hours', r.min_notice_hours, 'horizon_days', r.horizon_days, 'buffer_minutes', r.buffer_minutes,
    'slot_step_minutes', r.slot_step_minutes, 'share_with_client', r.share_with_client,
    'google', (select jsonb_build_object('status', a.status, 'email', a.email, 'connected_at', a.connected_at, 'last_error', a.last_error,
                 'connected_by', (select pr.name from public.profiles pr where pr.id = a.connected_by))
               from private.google_account a),
    'can_connect', private.is_global_admin());
end;
$$;

create or replace function private.meeting_settings_save(p_tenant uuid, p jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Somente a administração altera a agenda' using errcode = '42501'; end if;
  insert into public.meeting_settings (tenant_id, alignment_minutes, presentation_minutes, min_notice_hours, horizon_days, buffer_minutes,
                                       slot_step_minutes, share_with_client, updated_by, updated_at)
  values (p_tenant, (p ->> 'alignment_minutes')::int, (p ->> 'presentation_minutes')::int, (p ->> 'min_notice_hours')::int,
          (p ->> 'horizon_days')::int, (p ->> 'buffer_minutes')::int, (p ->> 'slot_step_minutes')::int,
          coalesce((p ->> 'share_with_client')::boolean, false), private.current_profile_id(), now())
  on conflict (tenant_id) do update set alignment_minutes = excluded.alignment_minutes, presentation_minutes = excluded.presentation_minutes,
    min_notice_hours = excluded.min_notice_hours, horizon_days = excluded.horizon_days, buffer_minutes = excluded.buffer_minutes,
    slot_step_minutes = excluded.slot_step_minutes, share_with_client = excluded.share_with_client,
    updated_by = excluded.updated_by, updated_at = now();
exception when check_violation or not_null_violation or invalid_text_representation then
  raise exception 'Valores fora do permitido: duração de 15 a 240 min, antecedência até 336 h, até 120 dias à frente, intervalo até 120 min' using errcode = '23514';
end;
$$;

create or replace function private.google_oauth_start(p_return text) returns text
language plpgsql security definer set search_path = ''
as $$
declare v_state text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global conecta a conta Google' using errcode = '42501'; end if;
  insert into private.google_oauth_states (state, profile_id, return_to) values (v_state, private.current_profile_id(), left(p_return, 300));
  return v_state;
end;
$$;

create or replace function private.google_disconnect() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global desconecta a conta Google' using errcode = '42501'; end if;
  update private.google_account set refresh_token = null, status = 'disconnected', updated_at = now() where id = 1;
  perform private.log_audit('google_disconnected', 'google_account', null, null, '{}'::jsonb);
end;
$$;

-- Somente a Edge Function (service_role):
create or replace function private.google_oauth_take(p_state text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare s private.google_oauth_states;
begin
  update private.google_oauth_states set used_at = now()
   where state = p_state and used_at is null and created_at > now() - interval '15 minutes'
  returning * into s;
  if s.state is null then return null; end if;
  return jsonb_build_object('profile_id', s.profile_id, 'return_to', s.return_to);
end;
$$;

create or replace function private.google_account_save(p_email text, p_refresh text, p_scopes text, p_profile uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.google_account (id, email, domain, refresh_token, scopes, status, last_error, connected_by, connected_at, updated_at)
  values (1, lower(p_email), split_part(lower(p_email), '@', 2), p_refresh, p_scopes, 'connected', null, p_profile, now(), now())
  on conflict (id) do update set email = excluded.email, domain = excluded.domain,
    refresh_token = coalesce(excluded.refresh_token, private.google_account.refresh_token),
    scopes = excluded.scopes, status = 'connected', last_error = null, connected_by = excluded.connected_by,
    connected_at = now(), updated_at = now(),
    root_folder_id = case when private.google_account.email = excluded.email then private.google_account.root_folder_id end;
end;
$$;

create or replace function private.google_account_get() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('email', a.email, 'domain', a.domain, 'refresh_token', a.refresh_token, 'root_folder_id', a.root_folder_id, 'status', a.status)
  from private.google_account a where a.id = 1 and a.status <> 'disconnected' and a.refresh_token is not null
$$;

create or replace function private.google_account_mark(p_status text, p_error text, p_root_folder text) returns void
language sql security definer set search_path = ''
as $$
  update private.google_account set status = coalesce(p_status, status), last_error = p_error,
    root_folder_id = coalesce(p_root_folder, root_folder_id), updated_at = now() where id = 1
$$;

create or replace function private.google_project_folder(p_project uuid, p_folder text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if p_folder is not null then
    insert into private.google_project_folders (project_id, folder_id) values (p_project, p_folder)
    on conflict (project_id) do update set folder_id = excluded.folder_id;
  end if;
  return (select jsonb_build_object('folder_id', f.folder_id, 'name', coalesce(p.code || ' · ', '') || p.name)
          from public.projects p left join private.google_project_folders f on f.project_id = p.id where p.id = p_project);
end;
$$;

create or replace function private.meeting_busy_put(p_profile uuid, p_from date, p_to date, p_intervals jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare d date;
begin
  for d in select g::date from generate_series(p_from, p_to, interval '1 day') g loop
    insert into public.meeting_busy (profile_id, day, intervals, fetched_at)
    values (p_profile, d, coalesce((select jsonb_agg(i) from jsonb_array_elements(coalesce(p_intervals, '[]'::jsonb)) i
                                   where ((i ->> 's')::timestamptz at time zone 'America/Sao_Paulo')::date <= d
                                     and ((i ->> 'e')::timestamptz at time zone 'America/Sao_Paulo')::date >= d), '[]'::jsonb), now())
    on conflict (profile_id, day) do update set intervals = excluded.intervals, fetched_at = now();
  end loop;
end;
$$;

-- Dados para criar a reunião no Google.
create or replace function private.meeting_google_payload(p_meeting uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', m.id, 'project_id', m.project_id, 'title', m.title, 'notes', m.notes,
    'starts_at', m.starts_at, 'ends_at', m.ends_at, 'record', m.record, 'transcribe', m.transcribe,
    'attendees', m.attendees, 'host_email', h.email, 'host_name', h.name,
    'project_name', p.name, 'project_code', p.code, 'kind_label', private.meeting_kind_label(m.kind),
    'meet_space', m.meet_space, 'calendar_event_id', m.calendar_event_id, 'status', m.status,
    'share_with_client', (select r.share_with_client from private.meeting_rules(m.tenant_id) r),
    'client_emails', (select coalesce(jsonb_agg(distinct x ->> 'email'), '[]'::jsonb) from jsonb_array_elements(m.attendees) x
                      where (x ->> 'email') is distinct from lower(h.email::text)
                        and not exists (select 1 from public.profiles s where lower(s.email::text) = (x ->> 'email') and s.role <> 'client')))
  from public.meetings m join public.profiles h on h.id = m.host_profile_id join public.projects p on p.id = m.project_id
  where m.id = p_meeting
$$;

create or replace function private.meeting_google_set(p_meeting uuid, p jsonb) returns void
language sql security definer set search_path = ''
as $$
  update public.meetings set
    meet_uri = coalesce(p ->> 'meet_uri', meet_uri), meet_code = coalesce(p ->> 'meet_code', meet_code),
    meet_space = coalesce(p ->> 'meet_space', meet_space), calendar_event_id = coalesce(p ->> 'calendar_event_id', calendar_event_id),
    google_status = coalesce(p ->> 'google_status', google_status), google_error = p ->> 'google_error'
  where id = p_meeting
$$;

-- Reuniões do projeto que já terminaram e ainda esperam transcrição/gravação (a Edge Function busca no Meet).
create or replace function private.meetings_to_sync(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_view_project(p_project) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  return (select coalesce(jsonb_agg(m.id), '[]'::jsonb) from public.meetings m
          where m.project_id = p_project and m.status = 'scheduled' and m.meet_space is not null
            and m.ends_at < now() - interval '5 minutes' and m.ends_at > now() - interval '10 days'
            and m.artifacts_status in ('waiting', 'partial')
            and (m.artifacts_checked_at is null or m.artifacts_checked_at < now() - interval '10 minutes'));
end;
$$;

create or replace function private.meeting_artifacts_put(p_meeting uuid, p_transcript text, p_recording text, p_status text) returns void
language sql security definer set search_path = ''
as $$
  update public.meetings set transcript_url = coalesce(p_transcript, transcript_url), recording_url = coalesce(p_recording, recording_url),
    artifacts_status = coalesce(p_status, artifacts_status), artifacts_checked_at = now()
  where id = p_meeting
$$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos (portal)
-- -----------------------------------------------------------------------------
create or replace function public.meeting_options(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_options(p_project) $$;
create or replace function public.meeting_slot_target(p_project uuid, p_host uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_slot_target(p_project, p_host) $$;
create or replace function public.meeting_slots_portal(p_project uuid, p_host uuid, p_kind text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_slots_portal(p_project, p_host, p_kind) $$;
create or replace function public.meeting_book_portal(p_project uuid, p_host uuid, p_kind text, p_starts timestamptz, p_task uuid, p_notes text, p_record boolean) returns uuid
language sql security invoker set search_path = '' as $$ select private.meeting_book_portal(p_project, p_host, p_kind, p_starts, p_task, p_notes, p_record) $$;
create or replace function public.project_meetings(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_meetings(p_project) $$;
create or replace function public.my_meetings() returns jsonb
language sql security invoker set search_path = '' as $$ select private.my_meetings() $$;
create or replace function public.meeting_cancel(p_meeting uuid, p_reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_cancel(p_meeting, p_reason) $$;
create or replace function public.meeting_set_record(p_meeting uuid, p_record boolean) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_set_record(p_meeting, p_record) $$;
create or replace function public.meeting_set_link(p_meeting uuid, p_url text) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_set_link(p_meeting, p_url) $$;
create or replace function public.meeting_set_artifacts(p_meeting uuid, p_transcript text, p_recording text) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_set_artifacts(p_meeting, p_transcript, p_recording) $$;
create or replace function public.meeting_link_create(p_project uuid, p_host uuid, p_kind text, p_task uuid, p_days int) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_link_create(p_project, p_host, p_kind, p_task, p_days) $$;
create or replace function public.project_meeting_links(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_meeting_links(p_project) $$;
create or replace function public.meeting_link_disable(p_link uuid) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_link_disable(p_link) $$;
create or replace function public.my_availability() returns jsonb
language sql security invoker set search_path = '' as $$ select private.my_availability() $$;
create or replace function public.availability_save(p_rules jsonb, p_bookable boolean) returns void
language sql security invoker set search_path = '' as $$ select private.availability_save(p_rules, p_bookable) $$;
create or replace function public.availability_block_add(p_starts timestamptz, p_ends timestamptz, p_reason text) returns uuid
language sql security invoker set search_path = '' as $$ select private.availability_block_add(p_starts, p_ends, p_reason) $$;
create or replace function public.availability_block_remove(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.availability_block_remove(p_id) $$;
create or replace function public.meeting_settings_get(p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_settings_get(p_tenant) $$;
create or replace function public.meeting_settings_save(p_tenant uuid, p jsonb) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_settings_save(p_tenant, p) $$;
create or replace function public.google_oauth_start(p_return text) returns text
language sql security invoker set search_path = '' as $$ select private.google_oauth_start(p_return) $$;
create or replace function public.google_disconnect() returns void
language sql security invoker set search_path = '' as $$ select private.google_disconnect() $$;
create or replace function public.meetings_to_sync(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meetings_to_sync(p_project) $$;

-- Somente a Edge Function (service_role): link público, credenciais e retorno do Google.
create or replace function public.meeting_link_info(p_token text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_link_info(p_token) $$;
create or replace function public.meeting_link_slots(p_token text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_link_slots(p_token) $$;
create or replace function public.meeting_link_book(p_token text, p_starts timestamptz, p_name text, p_email text, p_phone text, p_notes text) returns uuid
language sql security invoker set search_path = '' as $$ select private.meeting_link_book(p_token, p_starts, p_name, p_email, p_phone, p_notes) $$;
create or replace function public.google_oauth_take(p_state text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.google_oauth_take(p_state) $$;
create or replace function public.google_account_save(p_email text, p_refresh text, p_scopes text, p_profile uuid) returns void
language sql security invoker set search_path = '' as $$ select private.google_account_save(p_email, p_refresh, p_scopes, p_profile) $$;
create or replace function public.google_account_get() returns jsonb
language sql security invoker set search_path = '' as $$ select private.google_account_get() $$;
create or replace function public.google_account_mark(p_status text, p_error text, p_root_folder text) returns void
language sql security invoker set search_path = '' as $$ select private.google_account_mark(p_status, p_error, p_root_folder) $$;
create or replace function public.google_project_folder(p_project uuid, p_folder text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.google_project_folder(p_project, p_folder) $$;
create or replace function public.meeting_busy_target(p_host uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_busy_target(p_host) $$;
create or replace function public.meeting_busy_put(p_profile uuid, p_from date, p_to date, p_intervals jsonb) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_busy_put(p_profile, p_from, p_to, p_intervals) $$;
create or replace function public.meeting_google_payload(p_meeting uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.meeting_google_payload(p_meeting) $$;
create or replace function public.meeting_google_set(p_meeting uuid, p jsonb) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_google_set(p_meeting, p) $$;
create or replace function public.meeting_artifacts_put(p_meeting uuid, p_transcript text, p_recording text, p_status text) returns void
language sql security invoker set search_path = '' as $$ select private.meeting_artifacts_put(p_meeting, p_transcript, p_recording, p_status) $$;

-- -----------------------------------------------------------------------------
-- Permissões das funções
-- -----------------------------------------------------------------------------
do $$
declare f text;
begin
  -- Tudo novo começa fechado.
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('private', 'public')
             and p.proname in ('meeting_rules', 'meeting_minutes', 'meeting_kind_label', 'is_holiday', 'project_hosts', 'meeting_slots',
               'can_schedule_project', 'meeting_book_core', 'meeting_json', 'can_manage_meeting', 'can_cancel_meeting', 'meeting_options',
               'meeting_slot_target', 'meeting_busy_target', 'meeting_slots_portal', 'meeting_book_portal', 'project_meetings', 'my_meetings',
               'meeting_cancel', 'meeting_set_record', 'meeting_set_link', 'meeting_set_artifacts', 'meeting_link_create', 'meeting_link_row',
               'meeting_link_info', 'meeting_link_slots', 'meeting_link_book', 'project_meeting_links', 'meeting_link_disable',
               'my_availability', 'availability_save', 'availability_block_add', 'availability_block_remove', 'meeting_settings_get',
               'meeting_settings_save', 'google_oauth_start', 'google_disconnect', 'google_oauth_take', 'google_account_save',
               'google_account_get', 'google_account_mark', 'google_project_folder', 'meeting_busy_put', 'meeting_google_payload',
               'meeting_google_set', 'meetings_to_sync', 'meeting_artifacts_put') loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- Portal (usuário logado).
grant execute on function
  private.meeting_rules(uuid), private.meeting_minutes(uuid, text), private.meeting_kind_label(text), private.is_holiday(date, uuid),
  private.project_hosts(uuid), private.meeting_slots(uuid, int, boolean), private.can_schedule_project(uuid),
  private.meeting_json(public.meetings, boolean), private.can_manage_meeting(public.meetings), private.can_cancel_meeting(public.meetings),
  private.meeting_options(uuid), private.meeting_slot_target(uuid, uuid), private.meeting_busy_target(uuid),
  private.meeting_slots_portal(uuid, uuid, text), private.meeting_book_portal(uuid, uuid, text, timestamptz, uuid, text, boolean),
  private.meeting_book_core(uuid, uuid, text, timestamptz, uuid, text, boolean, text, uuid, text, text, text, uuid, boolean),
  private.project_meetings(uuid), private.my_meetings(), private.meeting_cancel(uuid, text), private.meeting_set_record(uuid, boolean),
  private.meeting_set_link(uuid, text), private.meeting_set_artifacts(uuid, text, text), private.meeting_link_create(uuid, uuid, text, uuid, int),
  private.project_meeting_links(uuid), private.meeting_link_disable(uuid), private.my_availability(), private.availability_save(jsonb, boolean),
  private.availability_block_add(timestamptz, timestamptz, text), private.availability_block_remove(uuid),
  private.meeting_settings_get(uuid), private.meeting_settings_save(uuid, jsonb), private.google_oauth_start(text), private.google_disconnect(),
  private.meetings_to_sync(uuid),
  public.meeting_options(uuid), public.meeting_slot_target(uuid, uuid), public.meeting_slots_portal(uuid, uuid, text),
  public.meeting_book_portal(uuid, uuid, text, timestamptz, uuid, text, boolean), public.project_meetings(uuid), public.my_meetings(),
  public.meeting_cancel(uuid, text), public.meeting_set_record(uuid, boolean), public.meeting_set_link(uuid, text),
  public.meeting_set_artifacts(uuid, text, text), public.meeting_link_create(uuid, uuid, text, uuid, int), public.project_meeting_links(uuid),
  public.meeting_link_disable(uuid), public.my_availability(), public.availability_save(jsonb, boolean),
  public.availability_block_add(timestamptz, timestamptz, text), public.availability_block_remove(uuid),
  public.meeting_settings_get(uuid), public.meeting_settings_save(uuid, jsonb), public.google_oauth_start(text), public.google_disconnect(),
  public.meetings_to_sync(uuid)
to authenticated;

-- Edge Function (service_role).
grant execute on function
  private.meeting_rules(uuid), private.meeting_minutes(uuid, text), private.meeting_kind_label(text), private.is_holiday(date, uuid),
  private.project_hosts(uuid), private.meeting_slots(uuid, int, boolean), private.meeting_busy_target(uuid),
  private.meeting_book_core(uuid, uuid, text, timestamptz, uuid, text, boolean, text, uuid, text, text, text, uuid, boolean),
  private.meeting_link_row(text), private.meeting_link_info(text), private.meeting_link_slots(text),
  private.meeting_link_book(text, timestamptz, text, text, text, text), private.google_oauth_take(text),
  private.google_account_save(text, text, text, uuid), private.google_account_get(), private.google_account_mark(text, text, text),
  private.google_project_folder(uuid, text), private.meeting_busy_put(uuid, date, date, jsonb), private.meeting_google_payload(uuid),
  private.meeting_google_set(uuid, jsonb), private.meeting_artifacts_put(uuid, text, text, text),
  public.meeting_link_info(text), public.meeting_link_slots(text), public.meeting_link_book(text, timestamptz, text, text, text, text),
  public.google_oauth_take(text), public.google_account_save(text, text, text, uuid), public.google_account_get(),
  public.google_account_mark(text, text, text), public.google_project_folder(uuid, text), public.meeting_busy_target(uuid),
  public.meeting_busy_put(uuid, date, date, jsonb), public.meeting_google_payload(uuid), public.meeting_google_set(uuid, jsonb),
  public.meeting_artifacts_put(uuid, text, text, text)
to service_role;
