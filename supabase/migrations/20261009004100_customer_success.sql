-- =============================================================================
-- 0041 · Customer Success
--
--   * Acesso "Customer Success": vê projetos, cronogramas, clientes e equipe
--     sem poder alterar nada (prazos, equipe, quadro). Na Franqueadora vê a
--     rede toda; numa franquia, os projetos da própria unidade.
--   * Chamados do CS para a equipe: esclarecimento do andamento, dúvida do
--     cliente ou alerta. Vão sempre para os líderes do projeto, com prazo de
--     resposta pela urgência (Normal / Alta em dias úteis, Urgente em horas),
--     ajustável pela administração. Conversa no próprio chamado.
--   * Dashboard do CS: chamados, tempo de resposta, projetos em risco e
--     próximas entregas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Papel no modelo de permissões
-- -----------------------------------------------------------------------------
create or replace function private.role_rank(r public.user_role) returns integer
language sql immutable set search_path = ''
as $$
  select case r
    when 'client'           then 0
    when 'collaborator'     then 1
    when 'customer_success' then 1
    when 'leader'           then 2
    when 'unit_admin'       then 3
    when 'global_admin'     then 4
  end
$$;

create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() in ('collaborator', 'customer_success', 'leader', 'unit_admin', 'global_admin'), false) $$;

create or replace function private.is_cs() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'customer_success', false) $$;

-- CS da Franqueadora acompanha a rede toda.
create or replace function private.tenant_is_headquarters(p_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.tenants t where t.id = p_tenant and t.type = 'franqueadora') $$;

revoke all on function private.is_cs(), private.tenant_is_headquarters(uuid) from public, anon;
grant execute on function private.is_cs(), private.tenant_is_headquarters(uuid) to authenticated;

create or replace function private.can_view_project(p_project uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  p  public.projects;
begin
  if me.id is null then return false; end if;
  select * into p from public.projects where id = p_project;
  if p.id is null then return false; end if;
  case me.role
    when 'global_admin' then return true;
    when 'unit_admin', 'leader' then
      return me.tenant_id in (p.delivery_tenant_id, p.commercial_tenant_id);
    when 'customer_success' then
      return private.tenant_is_headquarters(me.tenant_id) or me.tenant_id in (p.delivery_tenant_id, p.commercial_tenant_id);
    when 'collaborator' then
      return exists (select 1 from public.project_team t
                     where t.project_id = p.id and t.user_id = me.id and t.active);
    when 'client' then
      return exists (select 1 from public.client_contacts cc
                     where cc.client_id = p.client_id and cc.profile_id = me.id and cc.active);
    else return false;
  end case;
end;
$$;

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
    when 'customer_success' then
      return private.tenant_is_headquarters(me.tenant_id) or me.tenant_id in (p.delivery_tenant_id, p.commercial_tenant_id);
    when 'collaborator' then
      return exists (select 1 from public.project_team t where t.project_id = p.id and t.user_id = me.id and t.active);
    when 'client' then
      return exists (select 1 from public.client_contacts cc where cc.client_id = p.client_id and cc.profile_id = me.id and cc.active);
    else return false;
  end case;
end;
$$;

create or replace function private.can_view_profile(target_profile uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  me     public.profiles := private.current_profile();
  target public.profiles;
begin
  if me.id is null then return false; end if;
  if me.id = target_profile then return true; end if;
  if me.role = 'global_admin' then return true; end if;
  select * into target from public.profiles where id = target_profile;
  if target.id is null then return false; end if;
  if me.role in ('unit_admin','leader') then return me.tenant_id = target.tenant_id; end if;
  if me.role = 'customer_success' then
    return private.tenant_is_headquarters(me.tenant_id) or me.tenant_id = target.tenant_id;
  end if;
  if me.role = 'collaborator' then
    return me.tenant_id = target.tenant_id and target.role <> 'client';
  end if;
  return false;
end;
$$;

create or replace function private.can_access_tenant(target_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.is_staff() and private.current_tenant_id() = target_tenant)
      or (private.is_cs() and private.tenant_is_headquarters(private.current_tenant_id()))
$$;

-- CS acompanha, não pede ajuste de prazo.
create or replace function private.guard_cs_adjustment() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.profiles where id = new.requested_by and role = 'customer_success') then
    raise exception 'O acesso de Customer Success acompanha o projeto; para mudar prazos, abra um chamado para a equipe' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger adjustment_requests_cs_guard before insert on public.adjustment_requests
  for each row execute function private.guard_cs_adjustment();

-- -----------------------------------------------------------------------------
-- Prazos de resposta (por unidade)
-- -----------------------------------------------------------------------------
create table public.cs_settings (
  tenant_id    uuid primary key references public.tenants (id),
  normal_days  int not null default 2 check (normal_days between 1 and 30),
  high_days    int not null default 1 check (high_days between 1 and 30),
  urgent_hours int not null default 4 check (urgent_hours between 1 and 72),
  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now()
);
alter table public.cs_settings enable row level security;
revoke all on public.cs_settings from anon, authenticated;

-- Normal e Alta: fim do N-ésimo dia útil seguinte (18h). Urgente: N horas.
create or replace function private.cs_due_at(p_tenant uuid, p_urgency text, p_from timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = ''
as $$
declare
  s public.cs_settings;
  v_days int;
  v_day date;
begin
  select * into s from public.cs_settings where tenant_id = p_tenant;
  if p_urgency = 'urgent' then return p_from + make_interval(hours => coalesce(s.urgent_hours, 4)); end if;
  v_days := case when p_urgency = 'high' then coalesce(s.high_days, 1) else coalesce(s.normal_days, 2) end;
  v_day := public.add_business_days(((p_from at time zone 'America/Sao_Paulo')::date + 1), v_days, private.calendar_for_tenant(p_tenant));
  return (v_day + time '18:00') at time zone 'America/Sao_Paulo';
end;
$$;

-- -----------------------------------------------------------------------------
-- Chamados do CS
-- -----------------------------------------------------------------------------
create table public.cs_requests (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id),
  tenant_id         uuid not null references public.tenants (id),
  kind              text not null check (kind in ('clarification', 'client_question', 'alert')),
  urgency           text not null default 'normal' check (urgency in ('normal', 'high', 'urgent')),
  title             text not null check (length(trim(title)) between 3 and 140),
  body              text not null check (length(trim(body)) between 3 and 4000),
  task_id           uuid references public.project_tasks (id),
  recipients        uuid[] not null default '{}',
  status            text not null default 'open' check (status in ('open', 'answered', 'resolved', 'cancelled')),
  due_at            timestamptz not null,
  created_by        uuid not null references public.profiles (id),
  created_at        timestamptz not null default now(),
  first_response_at timestamptz,
  first_response_by uuid references public.profiles (id),
  last_reply_at     timestamptz,
  resolved_at       timestamptz,
  resolved_by       uuid references public.profiles (id),
  updated_at        timestamptz not null default now()
);
create index cs_requests_project_idx on public.cs_requests (project_id, status);
create index cs_requests_tenant_idx on public.cs_requests (tenant_id, status, created_at desc);
create index cs_requests_recipients_idx on public.cs_requests using gin (recipients);
create trigger cs_requests_touch before update on public.cs_requests for each row execute function private.touch_updated_at();

create table public.cs_request_messages (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.cs_requests (id),
  author_id  uuid not null references public.profiles (id),
  body       text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index cs_request_messages_req_idx on public.cs_request_messages (request_id, created_at);

alter table public.cs_requests enable row level security;
alter table public.cs_request_messages enable row level security;
revoke all on public.cs_requests, public.cs_request_messages from anon, authenticated;

create or replace function private.can_view_cs_request(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_staff() and private.can_view_project(p_project) $$;

-- Quem abre chamados: o CS e a administração.
create or replace function private.can_open_cs_request(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select (private.is_cs() or private.my_role() in ('unit_admin', 'global_admin')) and private.can_view_project(p_project) $$;

revoke all on function private.can_view_cs_request(uuid), private.can_open_cs_request(uuid), private.cs_due_at(uuid, text, timestamptz) from public, anon;
grant execute on function private.can_view_cs_request(uuid), private.can_open_cs_request(uuid), private.cs_due_at(uuid, text, timestamptz) to authenticated;

create or replace function private.cs_kind_label(p_kind text) returns text
language sql immutable set search_path = ''
as $$ select case p_kind when 'clarification' then 'Esclarecimento' when 'client_question' then 'Dúvida do cliente' else 'Alerta' end $$;

create or replace function private.cs_request_json(r public.cs_requests) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'project_id', r.project_id, 'tenant_id', r.tenant_id,
    'project_name', p.name, 'project_code', p.code, 'client_name', c.name,
    'kind', r.kind, 'urgency', r.urgency, 'title', r.title, 'body', r.body,
    'task', case when t.id is not null then jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'planned_end_date', t.planned_end_date) end,
    'status', r.status, 'due_at', r.due_at, 'created_at', r.created_at, 'first_response_at', r.first_response_at,
    'last_reply_at', r.last_reply_at, 'resolved_at', r.resolved_at,
    'created_by', jsonb_build_object('id', cb.id, 'name', cb.name),
    'recipients', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'avatar_url', x.avatar_url) order by x.name), '[]'::jsonb)
                   from public.profiles x where x.id = any (r.recipients)),
    'messages', (select count(*) from public.cs_request_messages m where m.request_id = r.id),
    'last_message', (select jsonb_build_object('author', a.name, 'body', left(m.body, 160), 'at', m.created_at, 'from_cs', a.role = 'customer_success')
                     from public.cs_request_messages m join public.profiles a on a.id = m.author_id
                     where m.request_id = r.id order by m.created_at desc limit 1),
    'overdue', r.status = 'open' and r.first_response_at is null and r.due_at < now(),
    'answered_late', r.first_response_at is not null and r.first_response_at > r.due_at,
    'is_recipient', private.current_profile_id() = any (r.recipients),
    'can_close', r.status in ('open', 'answered') and (private.is_cs() or private.can_manage_project(r.project_id)),
    'can_reopen', r.status in ('resolved', 'cancelled') and (private.is_cs() or private.can_manage_project(r.project_id))
  )
  from public.projects p
  left join public.clients c on c.id = p.client_id
  left join public.project_tasks t on t.id = r.task_id
  join public.profiles cb on cb.id = r.created_by
  where p.id = r.project_id
$$;

create or replace function private.cs_request_create(p_project uuid, p_kind text, p_urgency text, p_title text, p_body text, p_task uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  v_id uuid;
  v_to uuid[];
  v_user uuid;
  v_urg text := coalesce(nullif(p_urgency, ''), case when p_kind = 'alert' then 'urgent' else 'normal' end);
  v_title text;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_open_cs_request(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para abrir chamado' using errcode = '42501';
  end if;
  if p_kind not in ('clarification', 'client_question', 'alert') then raise exception 'Tipo de chamado inválido' using errcode = '23514'; end if;
  if v_urg not in ('normal', 'high', 'urgent') then raise exception 'Urgência inválida' using errcode = '23514'; end if;
  if length(trim(coalesce(p_title, ''))) < 3 then raise exception 'Escreva o assunto' using errcode = '23514'; end if;
  if length(trim(coalesce(p_body, ''))) < 3 then raise exception 'Descreva o que precisa' using errcode = '23514'; end if;
  if p_task is not null and not exists (select 1 from public.project_tasks where id = p_task and project_id = p.id) then
    raise exception 'Etapa inválida' using errcode = '23514';
  end if;

  v_to := private.project_leaders(p.id, null);
  insert into public.cs_requests (project_id, tenant_id, kind, urgency, title, body, task_id, recipients, due_at, created_by)
  values (p.id, coalesce(p.delivery_tenant_id, p.commercial_tenant_id), p_kind, v_urg, trim(p_title), trim(p_body), p_task, v_to,
          private.cs_due_at(coalesce(p.delivery_tenant_id, p.commercial_tenant_id), v_urg, now()), private.current_profile_id())
  returning id into v_id;

  v_title := case when p_kind = 'alert' or v_urg = 'urgent' then 'Alerta do CS' || case when v_urg = 'urgent' then ' (urgente)' else '' end
                  else 'Chamado do CS: ' || lower(private.cs_kind_label(p_kind)) end;
  foreach v_user in array v_to loop
    if v_user <> private.current_profile_id() then
      perform private.notify(coalesce(p.delivery_tenant_id, p.commercial_tenant_id), case when p_kind = 'alert' or v_urg = 'urgent' then 'cs_alert' else 'cs_request' end,
        v_title, trim(p_title) || ' · ' || p.name, 'cs_requests', v_id, jsonb_build_object('project_id', p.id), null, v_user);
    end if;
  end loop;
  if coalesce(array_length(v_to, 1), 0) = 0 then
    perform private.notify(coalesce(p.delivery_tenant_id, p.commercial_tenant_id), 'cs_request', v_title || ' (projeto sem líder)',
      trim(p_title) || ' · ' || p.name, 'cs_requests', v_id, jsonb_build_object('project_id', p.id), array['unit_admin']::public.user_role[], null);
  end if;
  perform private.log_audit('cs_request_created', 'cs_requests', v_id, p.delivery_tenant_id, jsonb_build_object('kind', p_kind, 'urgency', v_urg));
  return v_id;
end;
$$;

create or replace function private.cs_request_reply(p_id uuid, p_body text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.cs_requests;
  v_me uuid := private.current_profile_id();
  v_cs boolean := private.is_cs() or (select created_by from public.cs_requests where id = p_id) = private.current_profile_id();
  v_user uuid;
  v_pname text;
begin
  select * into r from public.cs_requests where id = p_id for update;
  if r.id is null or not private.can_view_cs_request(r.project_id) then
    raise exception 'Chamado não encontrado' using errcode = 'P0002';
  end if;
  if r.status = 'cancelled' then raise exception 'Chamado cancelado' using errcode = '23514'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Escreva a mensagem' using errcode = '23514'; end if;
  insert into public.cs_request_messages (request_id, author_id, body) values (r.id, v_me, trim(p_body));
  select name into v_pname from public.projects where id = r.project_id;

  if v_cs then
    -- CS complementa ou pergunta de novo: volta a aguardar a equipe.
    update public.cs_requests set status = 'open', resolved_at = null, resolved_by = null where id = r.id;
    foreach v_user in array r.recipients loop
      if v_user <> v_me then
        perform private.notify(r.tenant_id, 'cs_reply', 'Nova mensagem do CS', r.title || ' · ' || v_pname,
          'cs_requests', r.id, jsonb_build_object('project_id', r.project_id), null, v_user);
      end if;
    end loop;
  else
    update public.cs_requests set
      status = case when status = 'open' then 'answered' else status end,
      first_response_at = coalesce(first_response_at, now()), first_response_by = coalesce(first_response_by, v_me),
      last_reply_at = now()
    where id = r.id;
    if r.created_by <> v_me then
      perform private.notify(r.tenant_id, 'cs_reply', 'A equipe respondeu seu chamado', r.title || ' · ' || v_pname,
        'cs_requests', r.id, jsonb_build_object('project_id', r.project_id), null, r.created_by);
    end if;
  end if;
end;
$$;

create or replace function private.cs_request_set_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = ''
as $$
declare r public.cs_requests;
begin
  select * into r from public.cs_requests where id = p_id for update;
  if r.id is null or not private.can_view_cs_request(r.project_id) or not (private.is_cs() or private.can_manage_project(r.project_id)) then
    raise exception 'Chamado não encontrado ou sem permissão' using errcode = '42501';
  end if;
  if p_status not in ('resolved', 'cancelled', 'open') then raise exception 'Situação inválida' using errcode = '23514'; end if;
  if p_status = 'open' and r.status not in ('resolved', 'cancelled') then raise exception 'O chamado já está aberto' using errcode = '23514'; end if;
  if p_status in ('resolved', 'cancelled') and r.status not in ('open', 'answered') then raise exception 'O chamado já foi encerrado' using errcode = '23514'; end if;
  update public.cs_requests set
    status = case when p_status = 'open' then case when r.first_response_at is null then 'open' else 'answered' end else p_status end,
    resolved_at = case when p_status = 'open' then null else now() end,
    resolved_by = case when p_status = 'open' then null else private.current_profile_id() end
  where id = r.id;
end;
$$;

-- p_scope: 'all' (tudo que vejo), 'mine' (para mim ou aberto por mim), 'project' (um projeto)
create or replace function private.cs_requests_list(p_scope text, p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_me uuid := private.current_profile_id();
begin
  if not private.is_staff() then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(private.cs_request_json(r) order by
      (r.status in ('open', 'answered')) desc, (r.urgency = 'urgent') desc, r.due_at, r.created_at desc), '[]'::jsonb)
    from public.cs_requests r
    where (p_project is null or r.project_id = p_project)
      and (coalesce(p_scope, 'all') <> 'mine' or v_me = any (r.recipients) or r.created_by = v_me)
      and (r.status <> 'cancelled' or p_scope = 'project' or private.is_cs())
      and private.can_view_cs_request(r.project_id));
end;
$$;

create or replace function private.cs_request_detail(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r public.cs_requests;
begin
  select * into r from public.cs_requests where id = p_id;
  if r.id is null or not private.can_view_cs_request(r.project_id) then raise exception 'Chamado não encontrado' using errcode = 'P0002'; end if;
  return private.cs_request_json(r) || jsonb_build_object('thread', (
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
             'author', jsonb_build_object('id', a.id, 'name', a.name, 'avatar_url', a.avatar_url, 'role', a.role)) order by m.created_at), '[]'::jsonb)
    from public.cs_request_messages m join public.profiles a on a.id = m.author_id where m.request_id = r.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Dashboard do CS
-- -----------------------------------------------------------------------------
create or replace function private.cs_dashboard() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_today date := private.today_br();
  v_month date := date_trunc('month', private.today_br())::date;
begin
  if not (private.is_cs() or private.my_role() in ('unit_admin', 'global_admin')) then
    raise exception 'Sem acesso ao painel de Customer Success' using errcode = '42501';
  end if;
  return (
    with req as (
      select r.* from public.cs_requests r where r.status <> 'cancelled' and private.can_view_cs_request(r.project_id)
    ),
    proj as (
      select p.id, p.name, p.code, p.status, c.name as client_name
      from public.projects p left join public.clients c on c.id = p.client_id
      where p.status in ('in_progress', 'on_hold') and private.can_view_project(p.id)
    ),
    tk as (
      select t.*, pr.name as project_name, pr.code as project_code, pr.client_name
      from public.project_tasks t join proj pr on pr.id = t.project_id
      where t.status not in ('completed', 'cancelled')
    ),
    risk as (
      select pr.id, pr.name, pr.code, pr.client_name,
             count(*) filter (where tk.planned_end_date < v_today) as overdue_steps,
             max(v_today - tk.planned_end_date) filter (where tk.planned_end_date < v_today) as max_overdue_days,
             count(*) filter (where tk.status = 'waiting_client') as waiting_client,
             min(tk.planned_end_date) filter (where tk.planned_end_date >= v_today and tk.client_visible) as next_due,
             (select count(*) from req where req.project_id = pr.id and req.status in ('open', 'answered')) as open_requests
      from proj pr left join tk on tk.project_id = pr.id
      group by pr.id, pr.name, pr.code, pr.client_name
    ),
    resp as (
      select extract(epoch from (r.first_response_at - r.created_at)) / 3600.0 as hours, r.first_response_at <= r.due_at as on_time
      from req r where r.first_response_at is not null and r.created_at >= now() - interval '30 days'
    )
    select jsonb_build_object(
      'scope', case when private.is_global_admin() or (private.is_cs() and private.tenant_is_headquarters(private.current_tenant_id()))
                    then 'network' else 'unit' end,
      'counts', jsonb_build_object(
        'open', (select count(*) from req where status in ('open', 'answered')),
        'awaiting_team', (select count(*) from req where status = 'open'),
        'answered', (select count(*) from req where status = 'answered'),
        'urgent_open', (select count(*) from req where status in ('open', 'answered') and (urgency = 'urgent' or kind = 'alert')),
        'overdue', (select count(*) from req where status = 'open' and first_response_at is null and due_at < now()),
        'created_month', (select count(*) from req where created_at >= v_month),
        'resolved_month', (select count(*) from req where status = 'resolved' and resolved_at >= v_month)),
      'response', jsonb_build_object(
        'avg_hours', (select round(avg(hours)::numeric, 1) from resp),
        'on_time_pct', (select round(100.0 * count(*) filter (where on_time) / nullif(count(*), 0)) from resp),
        'answered', (select count(*) from resp)),
      'by_kind', (select coalesce(jsonb_agg(jsonb_build_object('kind', k, 'open', (select count(*) from req where kind = k and status in ('open', 'answered')),
                    'month', (select count(*) from req where kind = k and created_at >= v_month))), '[]'::jsonb)
                  from unnest(array['clarification', 'client_question', 'alert']) k),
      'trend', (select coalesce(jsonb_agg(jsonb_build_object('week', w,
                  'created', (select count(*) from req where created_at >= w and created_at < w + 7),
                  'resolved', (select count(*) from req where resolved_at >= w and resolved_at < w + 7)) order by w), '[]'::jsonb)
                from generate_series(date_trunc('week', v_today)::date - 49, date_trunc('week', v_today)::date, interval '7 days') as g(w0),
                     lateral (select g.w0::date as w) x),
      'attention', (select coalesce(jsonb_agg(private.cs_request_json(r) order by (r.due_at < now()) desc, r.due_at), '[]'::jsonb)
                    from (select * from public.cs_requests r where r.status in ('open', 'answered') and private.can_view_cs_request(r.project_id)
                            and (r.urgency = 'urgent' or r.kind = 'alert' or (r.status = 'open' and r.due_at < now()))
                          order by (r.due_at < now()) desc, r.due_at limit 6) r),
      'projects', jsonb_build_object(
        'active', (select count(*) from proj),
        'with_overdue', (select count(*) from risk where overdue_steps > 0),
        'waiting_client', (select count(*) from risk where waiting_client > 0)),
      'at_risk', (select coalesce(jsonb_agg(to_jsonb(x) order by x.overdue_steps desc, x.max_overdue_days desc nulls last, x.waiting_client desc), '[]'::jsonb)
                  from (select * from risk where overdue_steps > 0 or waiting_client > 0 or open_requests > 0
                        order by overdue_steps desc, max_overdue_days desc nulls last limit 8) x),
      'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('task_id', u.id, 'project_id', u.project_id, 'project_name', u.project_name,
                      'project_code', u.project_code, 'client_name', u.client_name, 'task', u.name, 'service', u.service, 'planned_end_date', u.planned_end_date,
                      'status', u.status, 'responsible', u.responsible) order by u.planned_end_date, u.project_name), '[]'::jsonb)
                   from (select tk.id, tk.project_id, tk.project_name, tk.project_code, tk.client_name, tk.name, tk.planned_end_date, tk.status,
                                s.name as service, rp.name as responsible
                         from tk
                         join public.project_schedule_tracks tr on tr.id = tk.schedule_track_id
                         join public.project_services ps on ps.id = tr.project_service_id
                         join public.services s on s.id = ps.service_id
                         left join public.profiles rp on rp.id = tk.responsible_user_id
                         where tk.client_visible and tk.planned_end_date between v_today and v_today + 14
                         order by tk.planned_end_date, tk.project_name limit 15) u)
    )
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Configuração dos prazos
-- -----------------------------------------------------------------------------
create or replace function private.cs_settings_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare s public.cs_settings;
begin
  if not (private.can_manage_tenant(p_tenant) or ((private.is_cs() or private.is_manager()) and p_tenant = private.current_tenant_id())) then
    raise exception 'Sem acesso' using errcode = '42501';
  end if;
  select * into s from public.cs_settings where tenant_id = p_tenant;
  return jsonb_build_object('tenant_id', p_tenant, 'normal_days', coalesce(s.normal_days, 2), 'high_days', coalesce(s.high_days, 1),
                            'urgent_hours', coalesce(s.urgent_hours, 4));
end;
$$;

create or replace function private.cs_settings_save(p_tenant uuid, p_normal_days int, p_high_days int, p_urgent_hours int) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Somente a administração ajusta os prazos' using errcode = '42501'; end if;
  if p_normal_days not between 1 and 30 or p_high_days not between 1 and 30 or p_urgent_hours not between 1 and 72 then
    raise exception 'Prazos inválidos' using errcode = '23514';
  end if;
  if p_high_days > p_normal_days then raise exception 'O prazo de Alta não pode ser maior que o de Normal' using errcode = '23514'; end if;
  insert into public.cs_settings (tenant_id, normal_days, high_days, urgent_hours, updated_by, updated_at)
  values (p_tenant, p_normal_days, p_high_days, p_urgent_hours, private.current_profile_id(), now())
  on conflict (tenant_id) do update set normal_days = excluded.normal_days, high_days = excluded.high_days,
    urgent_hours = excluded.urgent_hours, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos
-- -----------------------------------------------------------------------------
create or replace function public.cs_request_create(p_project uuid, p_kind text, p_urgency text, p_title text, p_body text, p_task uuid) returns uuid
language sql security invoker set search_path = '' as $$ select private.cs_request_create(p_project, p_kind, p_urgency, p_title, p_body, p_task) $$;
create or replace function public.cs_request_reply(p_id uuid, p_body text) returns void
language sql security invoker set search_path = '' as $$ select private.cs_request_reply(p_id, p_body) $$;
create or replace function public.cs_request_set_status(p_id uuid, p_status text) returns void
language sql security invoker set search_path = '' as $$ select private.cs_request_set_status(p_id, p_status) $$;
create or replace function public.cs_requests_list(p_scope text, p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.cs_requests_list(p_scope, p_project) $$;
create or replace function public.cs_request_detail(p_id uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.cs_request_detail(p_id) $$;
create or replace function public.cs_dashboard() returns jsonb
language sql security invoker set search_path = '' as $$ select private.cs_dashboard() $$;
create or replace function public.cs_settings_get(p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.cs_settings_get(p_tenant) $$;
create or replace function public.cs_settings_save(p_tenant uuid, p_normal_days int, p_high_days int, p_urgent_hours int) returns void
language sql security invoker set search_path = '' as $$ select private.cs_settings_save(p_tenant, p_normal_days, p_high_days, p_urgent_hours) $$;

revoke all on function
  private.cs_kind_label(text), private.cs_request_json(public.cs_requests), private.cs_request_create(uuid, text, text, text, text, uuid),
  private.cs_request_reply(uuid, text), private.cs_request_set_status(uuid, text), private.cs_requests_list(text, uuid),
  private.cs_request_detail(uuid), private.cs_dashboard(), private.cs_settings_get(uuid), private.cs_settings_save(uuid, int, int, int),
  public.cs_request_create(uuid, text, text, text, text, uuid), public.cs_request_reply(uuid, text), public.cs_request_set_status(uuid, text),
  public.cs_requests_list(text, uuid), public.cs_request_detail(uuid), public.cs_dashboard(), public.cs_settings_get(uuid),
  public.cs_settings_save(uuid, int, int, int)
from public, anon;
grant execute on function
  private.cs_kind_label(text), private.cs_request_json(public.cs_requests), private.cs_request_create(uuid, text, text, text, text, uuid),
  private.cs_request_reply(uuid, text), private.cs_request_set_status(uuid, text), private.cs_requests_list(text, uuid),
  private.cs_request_detail(uuid), private.cs_dashboard(), private.cs_settings_get(uuid), private.cs_settings_save(uuid, int, int, int),
  public.cs_request_create(uuid, text, text, text, text, uuid), public.cs_request_reply(uuid, text), public.cs_request_set_status(uuid, text),
  public.cs_requests_list(text, uuid), public.cs_request_detail(uuid), public.cs_dashboard(), public.cs_settings_get(uuid),
  public.cs_settings_save(uuid, int, int, int)
to authenticated;

-- -----------------------------------------------------------------------------
-- Permissões para a interface
-- -----------------------------------------------------------------------------
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
    'can_view_performance',  me.role <> 'customer_success' and private.can_view_performance(me.id),
    'can_view_approvals',    private.can_view_approvals(),
    'can_admin_approvals',   private.can_admin_approvals(me.tenant_id),
    'is_cs',                 me.role = 'customer_success',
    'is_manager',            private.is_manager(),
    'is_staff',              private.is_staff()
  );
end;
$$;
