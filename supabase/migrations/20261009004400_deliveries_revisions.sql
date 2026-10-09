-- =============================================================================
-- 0044 · Entregas do projeto e rodadas de revisão
--
--   * Cada serviço contratado tem a sua área de entregas, em duas fases:
--       Criação: apresentação preliminar + revisões (R1..Rn), dentro do limite
--                incluído no contrato (padrão 3, configurável por serviço);
--       Detalhamento: depois que o cliente aprova a criação, entra o projeto
--                final e não há mais revisões.
--     Serviços sem rodadas (trâmites, orçamentos, obra) recebem só a entrega.
--     Há ainda uma área "Documentos do projeto", sem revisões.
--   * A equipe prepara uma versão (rascunho), anexa arquivos (upload até 50 MB
--     ou link do Drive) e publica; o cliente é avisado.
--   * O cliente aprova a fase de criação ou pede revisão (lista de alterações)
--     no portal; a equipe pode registrar em nome dele.
--   * Revisão adicional (cortesia ou paga): a equipe solicita, o líder da área
--     do serviço (ou ADM) aprova. Se a criação já estava aprovada, ela reabre.
--   * Indicador: cada revisão conta para o responsável pela versão revisada
--     (por padrão, o responsável pela etapa de criação no cronograma).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Regras por serviço
-- -----------------------------------------------------------------------------
create table public.service_delivery_settings (
  service_id          uuid primary key references public.services (id),
  revisions_enabled   boolean not null default true,
  included_revisions  int not null default 3 check (included_revisions between 0 and 20),
  creation_task_codes text[] not null default '{}',
  updated_by          uuid references public.profiles (id) on delete set null,
  updated_at          timestamptz not null default now()
);
alter table public.service_delivery_settings enable row level security;
revoke all on public.service_delivery_settings from anon, authenticated;

insert into public.service_delivery_settings (service_id, revisions_enabled, included_revisions, creation_task_codes)
select s.id,
       f.code in ('arquitetura', 'interiores', 'engenharia', 'b2b_desenvolvimento'),
       case when f.code in ('arquitetura', 'interiores', 'engenharia', 'b2b_desenvolvimento') then 3 else 0 end,
       case when s.code = 'projeto_arquitetonico' then array['estudo_preliminar']
            when s.code = 'design_interiores' then array['projeto_interiores', 'layout_modelagem']
            when f.code = 'engenharia' then array['producao_disciplina']
            else '{}'::text[] end
from public.services s join public.service_families f on f.id = s.family_id
on conflict (service_id) do nothing;

create or replace function private.delivery_rules(p_service uuid)
returns table (revisions_enabled boolean, included_revisions int, creation_task_codes text[])
language sql stable security definer set search_path = ''
as $$
  select coalesce(x.revisions_enabled, true), coalesce(x.included_revisions, 3), coalesce(x.creation_task_codes, '{}'::text[])
  from (select 1) one left join public.service_delivery_settings x on x.service_id = p_service
$$;

-- -----------------------------------------------------------------------------
-- Tabelas
-- -----------------------------------------------------------------------------
create table public.project_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects (id),
  project_service_id   uuid unique references public.project_services (id), -- null = Documentos do projeto
  revisions_enabled    boolean not null,
  included_revisions   int not null check (included_revisions between 0 and 20),
  creation_approved_at timestamptz,
  creation_approved_by uuid references public.profiles (id),
  approval_on_behalf   boolean not null default false,
  approval_note        text check (approval_note is null or length(approval_note) <= 1000),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index project_deliveries_general_uidx on public.project_deliveries (project_id) where project_service_id is null;
create index project_deliveries_project_idx on public.project_deliveries (project_id);
create trigger project_deliveries_touch before update on public.project_deliveries for each row execute function private.touch_updated_at();

create table public.delivery_versions (
  id             uuid primary key default gen_random_uuid(),
  delivery_id    uuid not null references public.project_deliveries (id),
  project_id     uuid not null references public.projects (id),
  kind           text not null check (kind in ('presentation', 'revision', 'final', 'document')),
  round          int check (round is null or round >= 0),
  title          text not null check (length(trim(title)) between 2 and 120),
  notes          text check (notes is null or length(notes) <= 2000),
  responsible_id uuid references public.profiles (id),
  created_by     uuid references public.profiles (id),
  created_at     timestamptz not null default now(),
  published_at   timestamptz,
  published_by   uuid references public.profiles (id),
  archived_at    timestamptz,
  archived_by    uuid references public.profiles (id)
);
create index delivery_versions_delivery_idx on public.delivery_versions (delivery_id, published_at desc);
create index delivery_versions_responsible_idx on public.delivery_versions (responsible_id, published_at);
-- Uma versão em preparação por vez em cada entrega.
create unique index delivery_versions_one_draft on public.delivery_versions (delivery_id) where published_at is null and archived_at is null;

create table public.delivery_files (
  id           uuid primary key default gen_random_uuid(),
  version_id   uuid not null references public.delivery_versions (id),
  project_id   uuid not null references public.projects (id),
  kind         text not null check (kind in ('file', 'link')),
  name         text not null check (length(trim(name)) between 1 and 200),
  storage_path text,
  mime         text,
  size_bytes   bigint check (size_bytes is null or size_bytes >= 0),
  url          text check (url is null or length(url) <= 2000),
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  archived_at  timestamptz,
  constraint delivery_files_kind_chk check ((kind = 'file' and storage_path is not null) or (kind = 'link' and url is not null))
);
create index delivery_files_version_idx on public.delivery_files (version_id);

create table public.delivery_revision_requests (
  id                  uuid primary key default gen_random_uuid(),
  delivery_id         uuid not null references public.project_deliveries (id),
  project_id          uuid not null references public.projects (id),
  round               int not null check (round >= 1),
  version_id          uuid references public.delivery_versions (id),
  items               text[] not null check (cardinality(items) between 1 and 50),
  notes               text check (notes is null or length(notes) <= 2000),
  requested_by        uuid not null references public.profiles (id),
  on_behalf           boolean not null default false,
  responsible_id      uuid references public.profiles (id),
  created_at          timestamptz not null default now(),
  answered_version_id uuid references public.delivery_versions (id),
  answered_at         timestamptz,
  unique (delivery_id, round)
);
create index delivery_revision_requests_resp_idx on public.delivery_revision_requests (responsible_id, created_at);

create table public.delivery_extra_rounds (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references public.project_deliveries (id),
  project_id    uuid not null references public.projects (id),
  kind          text not null check (kind in ('courtesy', 'paid')),
  reason        text not null check (length(trim(reason)) between 5 and 1000),
  amount        numeric(12, 2) check (amount is null or amount >= 0),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by  uuid not null references public.profiles (id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references public.profiles (id),
  decided_at    timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000)
);
create index delivery_extra_rounds_delivery_idx on public.delivery_extra_rounds (delivery_id, status);
create unique index delivery_extra_rounds_one_pending on public.delivery_extra_rounds (delivery_id) where status = 'pending';

alter table public.project_deliveries enable row level security;
alter table public.delivery_versions enable row level security;
alter table public.delivery_files enable row level security;
alter table public.delivery_revision_requests enable row level security;
alter table public.delivery_extra_rounds enable row level security;
revoke all on public.project_deliveries, public.delivery_versions, public.delivery_files,
  public.delivery_revision_requests, public.delivery_extra_rounds from anon, authenticated;

create trigger delivery_versions_audit after insert or update on public.delivery_versions for each row execute function private.audit_row();
create trigger delivery_revision_requests_audit after insert or update on public.delivery_revision_requests for each row execute function private.audit_row();
create trigger delivery_extra_rounds_audit after insert or update on public.delivery_extra_rounds for each row execute function private.audit_row();
create trigger project_deliveries_audit after insert or update on public.project_deliveries for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Permissões
-- -----------------------------------------------------------------------------
-- Publica entregas: gestão do projeto e quem está na equipe do projeto.
create or replace function private.can_work_delivery(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_manage_project(p_project)
      or (private.my_role() in ('collaborator', 'leader', 'unit_admin')
          and exists (select 1 from public.project_team t
                      where t.project_id = p_project and t.user_id = private.current_profile_id() and t.active))
$$;

-- Libera revisão adicional: líder da área do serviço no projeto, ADM da unidade ou ADM Global.
create or replace function private.can_decide_extra(p_project uuid, p_ps uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_ps is not null and (
    private.is_global_admin()
    or (private.my_role() = 'unit_admin' and private.can_manage_project(p_project))
    or private.current_profile_id() = any (private.project_leaders(p_project, p_ps)))
$$;

-- -----------------------------------------------------------------------------
-- Cálculos
-- -----------------------------------------------------------------------------
create or replace function private.delivery_calc(p_delivery uuid)
returns table (allowed int, used int, open_request uuid, open_round int, last_creation uuid,
               last_creation_responsible uuid, last_final uuid, has_draft boolean, status text)
language sql stable security definer set search_path = ''
as $$
  with d as (select * from public.project_deliveries where id = p_delivery),
  v as (select * from public.delivery_versions where delivery_id = p_delivery and archived_at is null),
  lc as (select id, responsible_id from v where published_at is not null and kind in ('presentation', 'revision') order by published_at desc limit 1),
  lf as (select id from v where published_at is not null and kind in ('final', 'document') order by published_at desc limit 1),
  rq as (select id, round from public.delivery_revision_requests where delivery_id = p_delivery and answered_at is null order by round desc limit 1)
  select
    d.included_revisions + (select count(*)::int from public.delivery_extra_rounds e where e.delivery_id = d.id and e.status = 'approved'),
    (select count(*)::int from public.delivery_revision_requests r where r.delivery_id = d.id),
    (select id from rq), (select round from rq),
    (select id from lc), (select responsible_id from lc), (select id from lf),
    exists (select 1 from v where published_at is null),
    case
      when not d.revisions_enabled then case when exists (select 1 from lf) then 'delivered' else 'in_production' end
      when d.creation_approved_at is not null and exists (select 1 from lf) then 'final'
      when d.creation_approved_at is not null then 'detailing'
      when exists (select 1 from rq) then 'revision_requested'
      when exists (select 1 from lc) then 'awaiting_client'
      else 'in_production' end
  from d
$$;

-- Responsável pela etapa de criação do serviço (cronograma ou sub-etapa atribuída).
create or replace function private.delivery_creation_responsible(p_ps uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  with c as (select r.creation_task_codes codes from public.project_services ps
             cross join lateral private.delivery_rules(ps.service_id) r where ps.id = p_ps)
  select coalesce(
    (select pt.responsible_user_id
       from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id, c
      where tr.project_service_id = p_ps and pt.code = any (c.codes) and pt.responsible_user_id is not null and pt.status <> 'cancelled'
      order by array_position(c.codes, pt.code), pt.sequence limit 1),
    (select a.user_id from public.project_step_assignments a, c
      where a.project_service_id = p_ps and a.active and a.task_code = any (c.codes)
      order by array_position(c.codes, a.task_code) limit 1))
$$;

create or replace function private.delivery_ensure(p_project uuid, p_ps uuid) returns public.project_deliveries
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_deliveries;
  s record;
begin
  if p_ps is null then
    select * into d from public.project_deliveries where project_id = p_project and project_service_id is null;
    if d.id is null then
      insert into public.project_deliveries (project_id, project_service_id, revisions_enabled, included_revisions)
      values (p_project, null, false, 0) on conflict do nothing returning * into d;
      if d.id is null then select * into d from public.project_deliveries where project_id = p_project and project_service_id is null; end if;
    end if;
    return d;
  end if;
  select * into d from public.project_deliveries where project_service_id = p_ps;
  if d.id is not null then
    if d.project_id <> p_project then raise exception 'Serviço não encontrado neste projeto' using errcode = 'P0002'; end if;
    return d;
  end if;
  select ps.id, ps.project_id, r.revisions_enabled, r.included_revisions into s
    from public.project_services ps cross join lateral private.delivery_rules(ps.service_id) r
   where ps.id = p_ps and ps.active and ps.status <> 'cancelled';
  if s.id is null or s.project_id <> p_project then raise exception 'Serviço não encontrado neste projeto' using errcode = 'P0002'; end if;
  insert into public.project_deliveries (project_id, project_service_id, revisions_enabled, included_revisions)
  values (p_project, p_ps, s.revisions_enabled, s.included_revisions) on conflict do nothing returning * into d;
  if d.id is null then select * into d from public.project_deliveries where project_service_id = p_ps; end if;
  return d;
end;
$$;

create or replace function private.delivery_service_name(d public.project_deliveries) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select s.name from public.project_services ps join public.services s on s.id = ps.service_id where ps.id = d.project_service_id),
                  'Documentos do projeto')
$$;

-- Avisa os clientes com acesso ao projeto.
create or replace function private.notify_project_clients(p_project uuid, p_kind text, p_title text, p_body text,
                                                         p_entity_type text, p_entity_id uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  r record;
begin
  select * into p from public.projects where id = p_project;
  for r in select distinct cc.profile_id from public.client_contacts cc join public.profiles pr on pr.id = cc.profile_id
           where cc.client_id = p.client_id and cc.active and cc.profile_id is not null and pr.status = 'ativo' loop
    perform private.notify(coalesce(p.delivery_tenant_id, p.commercial_tenant_id), p_kind, p_title, p_body, p_entity_type, p_entity_id, p_data, null, r.profile_id);
  end loop;
end;
$$;

-- Avisa pessoas (sem repetir e sem avisar quem fez a ação).
create or replace function private.notify_people(p_people uuid[], p_tenant uuid, p_kind text, p_title text, p_body text,
                                                p_entity_type text, p_entity_id uuid, p_data jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare v uuid;
begin
  for v in select distinct x from unnest(p_people) x where x is not null and x is distinct from private.current_profile_id() loop
    perform private.notify(p_tenant, p_kind, p_title, p_body, p_entity_type, p_entity_id, p_data, null, v);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
create or replace function private.delivery_version_json(v public.delivery_versions, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', v.id, 'kind', v.kind, 'round', v.round, 'title', v.title, 'notes', v.notes,
    'created_at', v.created_at, 'published_at', v.published_at, 'is_draft', v.published_at is null,
    'published_by', (select x.name from public.profiles x where x.id = v.published_by),
    'responsible', case when p_staff then (select jsonb_build_object('id', x.id, 'name', x.name) from public.profiles x where x.id = v.responsible_id) end,
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'name', f.name, 'path', f.storage_path, 'url', f.url,
                 'mime', f.mime, 'size', f.size_bytes) order by f.created_at), '[]'::jsonb)
              from public.delivery_files f where f.version_id = v.id and f.archived_at is null))
$$;

create or replace function private.delivery_request_json(q public.delivery_revision_requests, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', q.id, 'round', q.round, 'items', to_jsonb(q.items), 'notes', q.notes, 'on_behalf', q.on_behalf,
    'requested_by', (select x.name from public.profiles x where x.id = q.requested_by),
    'created_at', q.created_at, 'answered_at', q.answered_at, 'answered_version_id', q.answered_version_id, 'version_id', q.version_id,
    'responsible', case when p_staff then (select jsonb_build_object('id', x.id, 'name', x.name) from public.profiles x where x.id = q.responsible_id) end)
$$;

create or replace function private.delivery_item_json(p_project uuid, p_ps uuid, p_staff boolean) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d public.project_deliveries;
  c record;
  v_name text;
  v_area text;
  v_sort int := 0;
  v_enabled boolean := false;
  v_included int := 0;
  v_resp uuid;
begin
  if p_ps is null then
    select * into d from public.project_deliveries where project_id = p_project and project_service_id is null;
    v_name := 'Documentos do projeto';
  else
    select * into d from public.project_deliveries where project_service_id = p_ps;
    select s.name, s.leadership_area, coalesce(s.sort_order, 0), r.revisions_enabled, r.included_revisions
      into v_name, v_area, v_sort, v_enabled, v_included
      from public.project_services ps join public.services s on s.id = ps.service_id
      cross join lateral private.delivery_rules(s.id) r where ps.id = p_ps;
    if d.id is not null then v_enabled := d.revisions_enabled; v_included := d.included_revisions; end if;
    if p_staff then v_resp := private.delivery_creation_responsible(p_ps); end if;
  end if;
  select * into c from private.delivery_calc(d.id);

  return jsonb_build_object(
    'key', coalesce(p_ps::text, 'general'), 'project_service_id', p_ps, 'delivery_id', d.id,
    'name', v_name, 'area', v_area, 'sort', v_sort, 'revisions_enabled', v_enabled, 'included', v_included,
    'allowed', coalesce(c.allowed, v_included), 'used', coalesce(c.used, 0),
    'status', coalesce(c.status, 'in_production'),
    'creation_approved_at', d.creation_approved_at, 'approval_on_behalf', coalesce(d.approval_on_behalf, false), 'approval_note', d.approval_note,
    'creation_approved_by', (select x.name from public.profiles x where x.id = d.creation_approved_by),
    'last_creation_version_id', c.last_creation, 'last_final_version_id', c.last_final, 'has_draft', coalesce(c.has_draft, false),
    'open_request', (select private.delivery_request_json(q, p_staff) from public.delivery_revision_requests q where q.id = c.open_request),
    'requests', (select coalesce(jsonb_agg(private.delivery_request_json(q, p_staff) order by q.round), '[]'::jsonb)
                 from public.delivery_revision_requests q where q.delivery_id = d.id),
    'versions', (select coalesce(jsonb_agg(private.delivery_version_json(v, p_staff) order by coalesce(v.published_at, 'infinity'::timestamptz) desc, v.created_at desc), '[]'::jsonb)
                 from public.delivery_versions v where v.delivery_id = d.id and v.archived_at is null and (p_staff or v.published_at is not null)),
    'extras', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'status', e.status, 'created_at', e.created_at,
                  'decided_at', e.decided_at,
                  'reason', case when p_staff then e.reason end, 'amount', case when p_staff then e.amount end,
                  'decision_note', case when p_staff then e.decision_note end,
                  'requested_by', case when p_staff then (select x.name from public.profiles x where x.id = e.requested_by) end,
                  'decided_by', case when p_staff then (select x.name from public.profiles x where x.id = e.decided_by) end)
                order by e.created_at desc), '[]'::jsonb)
               from public.delivery_extra_rounds e where e.delivery_id = d.id and (p_staff or e.status = 'approved')),
    'creation_responsible', (select jsonb_build_object('id', x.id, 'name', x.name) from public.profiles x where x.id = v_resp));
end;
$$;

create or replace function private.project_deliveries(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  v_staff boolean := private.is_staff();
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'status', p.status),
    'is_client', private.my_role() = 'client', 'is_staff', v_staff,
    'can_work', private.can_work_delivery(p.id),
    'can_request_extra', v_staff,
    'items', (select coalesce(jsonb_agg(x.j || jsonb_build_object('can_decide_extra', v_staff and private.can_decide_extra(p.id, x.id))
                                        order by (x.j ->> 'sort')::int, x.j ->> 'name'), '[]'::jsonb)
              from (select ps.id, private.delivery_item_json(p.id, ps.id, v_staff) j
                    from public.project_services ps where ps.project_id = p.id and ps.active and ps.status <> 'cancelled') x),
    'general', private.delivery_item_json(p.id, null, v_staff));
end;
$$;

-- Projetos do cliente com o resumo das entregas.
create or replace function private.delivery_projects() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.my_role() is distinct from 'client' then raise exception 'Disponível para o cliente' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code,
      'awaiting_client', (select count(*) from public.project_deliveries d cross join lateral private.delivery_calc(d.id) c
                          where d.project_id = p.id and c.status = 'awaiting_client'),
      'published', (select count(*) from public.delivery_versions v where v.project_id = p.id and v.published_at is not null and v.archived_at is null),
      'last_published_at', (select max(v.published_at) from public.delivery_versions v where v.project_id = p.id and v.archived_at is null))
      order by p.created_at desc), '[]'::jsonb)
    from public.projects p where p.status not in ('cancelled') and private.can_view_project(p.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Equipe: versões e arquivos
-- -----------------------------------------------------------------------------
create or replace function private.delivery_check_responsible(p_project uuid, p_resp uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_resp is not null and not exists (select 1 from public.profiles x where x.id = p_resp and x.status = 'ativo'
                                         and x.role in ('collaborator', 'leader', 'unit_admin', 'global_admin')
                                         and private.profile_can_view_project(x.id, p_project)) then
    raise exception 'Responsável inválido para este projeto' using errcode = '23514';
  end if;
end;
$$;

create or replace function private.delivery_version_start(p_project uuid, p_ps uuid, p_kind text, p_title text, p_notes text, p_responsible uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_deliveries;
  c record;
  v_id uuid;
  v_round int;
  v_resp uuid := p_responsible;
begin
  if not private.can_work_delivery(p_project) then raise exception 'Sem permissão para publicar entregas neste projeto' using errcode = '42501'; end if;
  d := private.delivery_ensure(p_project, p_ps);
  perform 1 from public.project_deliveries where id = d.id for update;
  if exists (select 1 from public.delivery_versions where delivery_id = d.id and published_at is null and archived_at is null) then
    raise exception 'Já existe uma versão em preparação nesta entrega. Publique ou descarte antes.' using errcode = '23514';
  end if;
  select * into c from private.delivery_calc(d.id);

  if p_ps is null then
    if p_kind is distinct from 'document' then raise exception 'Em Documentos do projeto, publique documentos' using errcode = '23514'; end if;
  elsif not d.revisions_enabled then
    if p_kind is distinct from 'final' then raise exception 'Este serviço não tem rodadas de revisão: publique a entrega' using errcode = '23514'; end if;
  elsif p_kind = 'presentation' then
    if c.last_creation is not null or d.creation_approved_at is not null then
      raise exception 'A apresentação preliminar já foi publicada' using errcode = '23514';
    end if;
    v_round := 0;
  elsif p_kind = 'revision' then
    if c.open_request is null then raise exception 'Não há pedido de revisão em aberto' using errcode = '23514'; end if;
    v_round := c.open_round;
  elsif p_kind = 'final' then
    if d.creation_approved_at is null then
      raise exception 'O projeto final entra depois que o cliente aprovar a fase de criação' using errcode = '23514';
    end if;
  else
    raise exception 'Tipo de entrega inválido' using errcode = '23514';
  end if;

  if v_resp is null and p_ps is not null then
    v_resp := coalesce(c.last_creation_responsible, private.delivery_creation_responsible(p_ps));
  end if;
  perform private.delivery_check_responsible(p_project, v_resp);

  insert into public.delivery_versions (delivery_id, project_id, kind, round, title, notes, responsible_id, created_by)
  values (d.id, p_project, p_kind, v_round,
          coalesce(nullif(trim(p_title), ''), case p_kind when 'presentation' then 'Apresentação preliminar'
            when 'revision' then 'Revisão ' || v_round when 'final' then 'Projeto final' else 'Documentos' end),
          nullif(trim(coalesce(p_notes, '')), ''), v_resp, private.current_profile_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.delivery_draft_for_edit(p_version uuid) returns public.delivery_versions
language plpgsql security definer set search_path = ''
as $$
declare v public.delivery_versions;
begin
  select * into v from public.delivery_versions where id = p_version and archived_at is null for update;
  if v.id is null or not private.can_work_delivery(v.project_id) then raise exception 'Versão não encontrada' using errcode = 'P0002'; end if;
  if v.published_at is not null then
    raise exception 'Esta versão já foi publicada. Para trocar arquivos, publique uma nova versão.' using errcode = '23514';
  end if;
  return v;
end;
$$;

create or replace function private.delivery_version_update(p_version uuid, p_title text, p_notes text, p_responsible uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.delivery_versions := private.delivery_draft_for_edit(p_version);
begin
  if length(trim(coalesce(p_title, ''))) < 2 then raise exception 'Informe o título da versão' using errcode = '23514'; end if;
  if v.kind <> 'document' then perform private.delivery_check_responsible(v.project_id, p_responsible); end if;
  update public.delivery_versions set title = trim(p_title), notes = nullif(trim(coalesce(p_notes, '')), ''),
    responsible_id = case when v.kind = 'document' then responsible_id else p_responsible end
  where id = v.id;
end;
$$;

create or replace function private.delivery_file_add(p_version uuid, p_kind text, p_name text, p_path text, p_mime text, p_size bigint, p_url text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v public.delivery_versions := private.delivery_draft_for_edit(p_version);
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if (select count(*) from public.delivery_files where version_id = v.id and archived_at is null) >= 100 then
    raise exception 'Limite de 100 arquivos por versão' using errcode = '23514';
  end if;
  if p_kind = 'file' then
    if p_path is null or p_path not like v.project_id::text || '/' || v.id::text || '/%' then
      raise exception 'Arquivo inválido' using errcode = '23514';
    end if;
    if v_name is null then raise exception 'Informe o nome do arquivo' using errcode = '23514'; end if;
  elsif p_kind = 'link' then
    if p_url is null or trim(p_url) !~* '^https?://\S+$' then
      raise exception 'Link inválido: use um endereço completo, começando com https://' using errcode = '23514';
    end if;
    v_name := coalesce(v_name, 'Link');
  else
    raise exception 'Tipo de arquivo inválido' using errcode = '23514';
  end if;
  insert into public.delivery_files (version_id, project_id, kind, name, storage_path, mime, size_bytes, url, created_by)
  values (v.id, v.project_id, p_kind, left(v_name, 200), case when p_kind = 'file' then p_path end, left(p_mime, 120), p_size,
          case when p_kind = 'link' then trim(p_url) end, private.current_profile_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.delivery_file_remove(p_file uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare f public.delivery_files;
begin
  select * into f from public.delivery_files where id = p_file and archived_at is null;
  if f.id is null then raise exception 'Arquivo não encontrado' using errcode = 'P0002'; end if;
  perform private.delivery_draft_for_edit(f.version_id);
  update public.delivery_files set archived_at = now() where id = f.id;
end;
$$;

create or replace function private.delivery_version_discard(p_version uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v public.delivery_versions := private.delivery_draft_for_edit(p_version);
begin
  update public.delivery_versions set archived_at = now(), archived_by = private.current_profile_id() where id = v.id;
end;
$$;

create or replace function private.delivery_version_publish(p_version uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v public.delivery_versions := private.delivery_draft_for_edit(p_version);
  d public.project_deliveries;
  p public.projects;
  c record;
  v_svc text;
  v_title text;
begin
  if not exists (select 1 from public.delivery_files where version_id = v.id and archived_at is null) then
    raise exception 'Anexe ao menos um arquivo ou link antes de publicar' using errcode = '23514';
  end if;
  select * into d from public.project_deliveries where id = v.delivery_id for update;
  select * into p from public.projects where id = v.project_id;
  select * into c from private.delivery_calc(d.id);
  if v.kind = 'presentation' and (c.last_creation is not null or d.creation_approved_at is not null) then
    raise exception 'A apresentação preliminar já foi publicada' using errcode = '23514';
  elsif v.kind = 'revision' and c.open_round is distinct from v.round then
    raise exception 'O pedido desta revisão não está mais em aberto' using errcode = '23514';
  elsif v.kind = 'final' and d.revisions_enabled and d.creation_approved_at is null then
    raise exception 'O projeto final entra depois que o cliente aprovar a fase de criação' using errcode = '23514';
  end if;

  update public.delivery_versions set published_at = now(), published_by = private.current_profile_id() where id = v.id;
  if v.kind = 'revision' then
    update public.delivery_revision_requests set answered_at = now(), answered_version_id = v.id where id = c.open_request;
    perform private.resolve_notifications('delivery_revision', d.id);
  end if;

  v_svc := private.delivery_service_name(d);
  v_title := case v.kind when 'presentation' then 'Apresentação disponível: ' || v_svc
                         when 'revision' then 'Revisão ' || v.round || ' disponível: ' || v_svc
                         when 'final' then case when d.revisions_enabled then 'Projeto final disponível: ' else 'Nova entrega: ' end || v_svc
                         else 'Novo documento no projeto' end;
  perform private.notify_project_clients(p.id, 'delivery_published', v_title,
    p.name || ' · ' || v.title || case when v.kind in ('presentation', 'revision') then ' · Aprove ou peça uma revisão pelo portal' else '' end,
    'project_deliveries', d.id, jsonb_build_object('project_id', p.id, 'version_id', v.id));
  perform private.log_audit('delivery_published', 'delivery_versions', v.id, coalesce(p.delivery_tenant_id, p.commercial_tenant_id),
    jsonb_build_object('kind', v.kind, 'round', v.round, 'delivery_id', d.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Cliente (ou equipe em nome dele): pedir revisão ou aprovar a criação
-- -----------------------------------------------------------------------------
create or replace function private.delivery_client_guard(p_project uuid, p_ps uuid) returns public.project_deliveries
language plpgsql security definer set search_path = ''
as $$
declare d public.project_deliveries;
begin
  if p_ps is null or not private.can_view_project(p_project) then raise exception 'Entrega não encontrada' using errcode = 'P0002'; end if;
  if private.my_role() is distinct from 'client' and not private.can_work_delivery(p_project) then
    raise exception 'Somente o cliente ou a equipe do projeto' using errcode = '42501';
  end if;
  d := private.delivery_ensure(p_project, p_ps);
  select * into d from public.project_deliveries where id = d.id for update;
  if not d.revisions_enabled then raise exception 'Este serviço não tem rodadas de revisão' using errcode = '23514'; end if;
  return d;
end;
$$;

create or replace function private.delivery_request_revision(p_project uuid, p_ps uuid, p_items text[], p_notes text) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_deliveries := private.delivery_client_guard(p_project, p_ps);
  c record;
  p public.projects;
  v_items text[];
  v_round int;
  v_svc text;
  v_client boolean := private.my_role() = 'client';
begin
  select * into c from private.delivery_calc(d.id);
  if d.creation_approved_at is not null then
    raise exception 'A fase de criação já foi aprovada. Uma nova revisão só como revisão adicional, combinada com a equipe.' using errcode = '23514';
  end if;
  if c.last_creation is null then raise exception 'Ainda não há apresentação para revisar' using errcode = '23514'; end if;
  if c.open_request is not null then raise exception 'Já existe uma revisão em andamento' using errcode = '23514'; end if;
  if c.used >= c.allowed then
    raise exception 'As % revisões incluídas já foram usadas. Para uma revisão adicional, fale com a equipe.', c.allowed using errcode = '23514';
  end if;
  select coalesce(array_agg(left(trim(x), 1000) order by o), '{}') into v_items
    from unnest(coalesce(p_items, '{}')) with ordinality as t(x, o) where trim(x) <> '';
  if cardinality(v_items) = 0 then raise exception 'Descreva ao menos uma alteração' using errcode = '23514'; end if;
  if cardinality(v_items) > 50 then raise exception 'Máximo de 50 alterações por revisão' using errcode = '23514'; end if;

  v_round := c.used + 1;
  insert into public.delivery_revision_requests (delivery_id, project_id, round, version_id, items, notes, requested_by, on_behalf, responsible_id)
  values (d.id, p_project, v_round, c.last_creation, v_items, nullif(trim(coalesce(p_notes, '')), ''),
          private.current_profile_id(), not v_client, c.last_creation_responsible);

  select * into p from public.projects where id = p_project;
  v_svc := private.delivery_service_name(d);
  perform private.notify_people(array_append(private.project_leaders(p.id, p_ps), c.last_creation_responsible),
    coalesce(p.delivery_tenant_id, p.commercial_tenant_id), 'delivery_revision', 'Revisão ' || v_round || ' solicitada: ' || v_svc,
    p.name || ' · ' || cardinality(v_items) || case when cardinality(v_items) = 1 then ' alteração' else ' alterações' end
      || case when not v_client then ' (registrada pela equipe)' else '' end,
    'project_deliveries', d.id, jsonb_build_object('project_id', p.id));
  return v_round;
end;
$$;

create or replace function private.delivery_approve(p_project uuid, p_ps uuid, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_deliveries := private.delivery_client_guard(p_project, p_ps);
  c record;
  p public.projects;
  v_client boolean := private.my_role() = 'client';
begin
  select * into c from private.delivery_calc(d.id);
  if d.creation_approved_at is not null then raise exception 'A fase de criação já está aprovada' using errcode = '23514'; end if;
  if c.last_creation is null then raise exception 'Ainda não há apresentação para aprovar' using errcode = '23514'; end if;
  if c.open_request is not null then raise exception 'Há uma revisão em andamento: aguarde a nova versão' using errcode = '23514'; end if;
  update public.project_deliveries set creation_approved_at = now(), creation_approved_by = private.current_profile_id(),
    approval_on_behalf = not v_client, approval_note = nullif(trim(coalesce(p_note, '')), '')
  where id = d.id;
  select * into p from public.projects where id = p_project;
  perform private.notify_people(array_append(private.project_leaders(p.id, p_ps), c.last_creation_responsible),
    coalesce(p.delivery_tenant_id, p.commercial_tenant_id), 'delivery_approved', 'Criação aprovada: ' || private.delivery_service_name(d),
    p.name || ' · segue para o detalhamento' || case when not v_client then ' (aprovação registrada pela equipe)' else '' end,
    'project_deliveries', d.id, jsonb_build_object('project_id', p.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Revisão adicional (cortesia ou paga)
-- -----------------------------------------------------------------------------
create or replace function private.delivery_extra_apply(p_extra uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.delivery_extra_rounds;
  d public.project_deliveries;
  p public.projects;
begin
  select * into e from public.delivery_extra_rounds where id = p_extra;
  select * into d from public.project_deliveries where id = e.delivery_id for update;
  select * into p from public.projects where id = d.project_id;
  if d.creation_approved_at is not null then
    -- A criação volta a ficar aberta para a nova rodada (a aprovação anterior fica na auditoria).
    perform private.log_audit('delivery_creation_reopened', 'project_deliveries', d.id, coalesce(p.delivery_tenant_id, p.commercial_tenant_id),
      jsonb_build_object('approved_at', d.creation_approved_at, 'approved_by', d.creation_approved_by, 'extra_id', e.id));
    update public.project_deliveries set creation_approved_at = null, creation_approved_by = null, approval_on_behalf = false, approval_note = null
    where id = d.id;
  end if;
  perform private.notify_project_clients(p.id, 'delivery_extra_released', 'Revisão adicional liberada: ' || private.delivery_service_name(d),
    p.name || ' · você pode pedir mais uma rodada de revisão pelo portal', 'project_deliveries', d.id, jsonb_build_object('project_id', p.id));
end;
$$;

create or replace function private.delivery_extra_request(p_project uuid, p_ps uuid, p_kind text, p_reason text, p_amount numeric) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_deliveries;
  p public.projects;
  v_id uuid;
  v_auto boolean;
begin
  if not private.is_staff() or not private.can_view_project(p_project) or p_ps is null then
    raise exception 'Sem permissão' using errcode = '42501';
  end if;
  if p_kind not in ('courtesy', 'paid') then raise exception 'Informe se a revisão é cortesia ou paga' using errcode = '23514'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Explique o motivo da revisão adicional' using errcode = '23514'; end if;
  d := private.delivery_ensure(p_project, p_ps);
  if not d.revisions_enabled then raise exception 'Este serviço não tem rodadas de revisão' using errcode = '23514'; end if;
  if exists (select 1 from public.delivery_extra_rounds where delivery_id = d.id and status = 'pending') then
    raise exception 'Já existe um pedido de revisão adicional aguardando a liderança' using errcode = '23514';
  end if;
  v_auto := private.can_decide_extra(p_project, p_ps);
  insert into public.delivery_extra_rounds (delivery_id, project_id, kind, reason, amount, status, requested_by, decided_by, decided_at)
  values (d.id, p_project, p_kind, trim(p_reason), case when p_kind = 'paid' then p_amount end,
          case when v_auto then 'approved' else 'pending' end, private.current_profile_id(),
          case when v_auto then private.current_profile_id() end, case when v_auto then now() end)
  returning id into v_id;
  select * into p from public.projects where id = p_project;
  if v_auto then
    perform private.delivery_extra_apply(v_id);
  else
    perform private.notify_people(private.project_leaders(p.id, p_ps), coalesce(p.delivery_tenant_id, p.commercial_tenant_id),
      'delivery_extra', 'Revisão adicional para aprovar: ' || private.delivery_service_name(d),
      p.name || ' · ' || case p_kind when 'courtesy' then 'cortesia' else 'paga' end || ' · ' || left(trim(p_reason), 140),
      'delivery_extra_rounds', v_id, jsonb_build_object('project_id', p.id));
  end if;
  return v_id;
end;
$$;

create or replace function private.delivery_extra_decide(p_id uuid, p_approve boolean, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  e public.delivery_extra_rounds;
  d public.project_deliveries;
  p public.projects;
begin
  select * into e from public.delivery_extra_rounds where id = p_id for update;
  if e.id is null then raise exception 'Pedido não encontrado' using errcode = 'P0002'; end if;
  select * into d from public.project_deliveries where id = e.delivery_id;
  if not private.can_decide_extra(e.project_id, d.project_service_id) then
    raise exception 'Somente o líder da área ou a administração libera revisão adicional' using errcode = '42501';
  end if;
  if e.status <> 'pending' then raise exception 'Este pedido já foi decidido' using errcode = '23514'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Explique por que não foi liberada' using errcode = '23514'; end if;
  update public.delivery_extra_rounds set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = private.current_profile_id(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '')
  where id = e.id;
  perform private.resolve_notifications('delivery_extra', e.id);
  if p_approve then perform private.delivery_extra_apply(e.id); end if;
  select * into p from public.projects where id = e.project_id;
  perform private.notify_people(array[e.requested_by], coalesce(p.delivery_tenant_id, p.commercial_tenant_id), 'delivery_extra_decided',
    case when p_approve then 'Revisão adicional liberada: ' else 'Revisão adicional não liberada: ' end || private.delivery_service_name(d),
    p.name || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), 'project_deliveries', d.id, jsonb_build_object('project_id', p.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Configuração por serviço
-- -----------------------------------------------------------------------------
create or replace function private.delivery_settings_list() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return jsonb_build_object('can_edit', private.is_global_admin(), 'services', (
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'family', f.name, 'area', s.leadership_area,
      'revisions_enabled', r.revisions_enabled, 'included_revisions', r.included_revisions, 'creation_task_codes', to_jsonb(r.creation_task_codes),
      'task_options', (select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'name', x.name) order by x.sort), '[]'::jsonb)
                       from (select distinct on (tt.code) tt.code, tt.name, tt.sort_order sort
                               from public.schedule_templates t join public.template_tasks tt on tt.template_id = t.id
                              where t.service_id = s.id and t.active and tt.active order by tt.code, tt.sort_order) x))
      order by f.sort_order, s.sort_order, s.name), '[]'::jsonb)
    from public.services s join public.service_families f on f.id = s.family_id
    cross join lateral private.delivery_rules(s.id) r where s.active));
end;
$$;

create or replace function private.delivery_settings_save(p_service uuid, p_enabled boolean, p_included int, p_codes text[]) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera as regras de revisão' using errcode = '42501'; end if;
  if p_included is null or p_included < 0 or p_included > 20 then raise exception 'Revisões incluídas: de 0 a 20' using errcode = '23514'; end if;
  if not exists (select 1 from public.services where id = p_service) then raise exception 'Serviço não encontrado' using errcode = 'P0002'; end if;
  insert into public.service_delivery_settings (service_id, revisions_enabled, included_revisions, creation_task_codes, updated_by, updated_at)
  values (p_service, coalesce(p_enabled, true), p_included, coalesce(p_codes, '{}'), private.current_profile_id(), now())
  on conflict (service_id) do update set revisions_enabled = excluded.revisions_enabled, included_revisions = excluded.included_revisions,
    creation_task_codes = excluded.creation_task_codes, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Indicador de revisões (mesma visibilidade da Performance)
-- -----------------------------------------------------------------------------
create or replace function private.revisions_overview(p_month date default null, p_tenant uuid default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  v_month date := date_trunc('month', coalesce(p_month, private.today_br()))::date;
  v_end date := (date_trunc('month', coalesce(p_month, private.today_br())) + interval '1 month' - interval '1 day')::date;
  v_manager boolean := private.is_manager();
  v_people uuid[];
begin
  if me.id is null or not private.is_staff() then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if not v_manager and not private.can_view_performance(me.id) then
    raise exception 'O indicador não está disponível para o seu perfil' using errcode = '42501';
  end if;
  v_people := case when v_manager then private.perf_people(case when me.role = 'global_admin' then p_tenant else me.tenant_id end) else array[me.id] end;

  return (
    with appr as (
      select c.last_creation_responsible resp, c.used rounds
      from public.project_deliveries d cross join lateral private.delivery_calc(d.id) c
      where d.creation_approved_at is not null and (d.creation_approved_at at time zone 'America/Sao_Paulo')::date between v_month and v_end),
    ext as (
      select c.last_creation_responsible resp, e.kind
      from public.delivery_extra_rounds e join public.project_deliveries d on d.id = e.delivery_id
      cross join lateral private.delivery_calc(d.id) c
      where e.status = 'approved' and (e.decided_at at time zone 'America/Sao_Paulo')::date between v_month and v_end),
    ppl as (
      select pr.id, pr.name, pr.avatar_url,
        (select count(*) from public.delivery_versions v where v.responsible_id = pr.id and v.kind = 'presentation' and v.archived_at is null
           and v.published_at is not null and (v.published_at at time zone 'America/Sao_Paulo')::date between v_month and v_end)::int presentations,
        (select count(*) from public.delivery_revision_requests q where q.responsible_id = pr.id
           and (q.created_at at time zone 'America/Sao_Paulo')::date between v_month and v_end)::int revisions,
        (select count(*) from appr a where a.resp = pr.id)::int approved,
        (select coalesce(sum(a.rounds), 0) from appr a where a.resp = pr.id)::int approved_rounds,
        (select count(*) from ext x where x.resp = pr.id and x.kind = 'courtesy')::int courtesy,
        (select count(*) from ext x where x.resp = pr.id and x.kind = 'paid')::int paid
      from public.profiles pr where pr.id = any (v_people))
    select jsonb_build_object('month', v_month, 'month_end', v_end, 'scope', case when v_manager then 'team' else 'self' end,
      'people', coalesce((select jsonb_agg(to_jsonb(r) order by r.revisions desc, r.name) from ppl r), '[]'::jsonb)));
end;
$$;

create or replace function private.revisions_person(p_profile uuid, p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_month date := date_trunc('month', coalesce(p_month, private.today_br()))::date;
  v_end date := (date_trunc('month', coalesce(p_month, private.today_br())) + interval '1 month' - interval '1 day')::date;
begin
  if not private.can_view_performance(p_profile) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'round', q.round, 'created_at', q.created_at, 'items', cardinality(q.items),
      'on_behalf', q.on_behalf, 'project_id', p.id, 'project_name', p.name, 'project_code', p.code, 'service', private.delivery_service_name(d),
      'allowed', c.allowed, 'approved', d.creation_approved_at is not null) order by q.created_at desc), '[]'::jsonb)
    from public.delivery_revision_requests q
    join public.project_deliveries d on d.id = q.delivery_id
    join public.projects p on p.id = q.project_id
    cross join lateral private.delivery_calc(d.id) c
    where q.responsible_id = p_profile and (q.created_at at time zone 'America/Sao_Paulo')::date between v_month and v_end);
end;
$$;

-- -----------------------------------------------------------------------------
-- Armazenamento dos arquivos (até 50 MB cada; arquivos maiores entram por link)
-- -----------------------------------------------------------------------------
create or replace function private.delivery_file_readable(p_project text, p_version text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return exists (select 1 from public.delivery_versions v
                 where v.id = p_version::uuid and v.project_id = p_project::uuid
                   and private.can_view_project(v.project_id) and (v.published_at is not null or private.is_staff()));
exception when others then return false;
end;
$$;

create or replace function private.delivery_file_writable(p_project text, p_version text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return exists (select 1 from public.delivery_versions v
                 where v.id = p_version::uuid and v.project_id = p_project::uuid and v.published_at is null and v.archived_at is null
                   and private.can_work_delivery(v.project_id));
exception when others then return false;
end;
$$;

do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('project-deliveries', 'project-deliveries', false, 52428800)
    on conflict (id) do update set public = false, file_size_limit = 52428800;
    execute $p$create policy project_deliveries_select on storage.objects for select to authenticated
      using (bucket_id = 'project-deliveries' and private.delivery_file_readable((storage.foldername(name))[1], (storage.foldername(name))[2]))$p$;
    execute $p$create policy project_deliveries_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'project-deliveries' and private.delivery_file_writable((storage.foldername(name))[1], (storage.foldername(name))[2]))$p$;
  end if;
end;
$do$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos
-- -----------------------------------------------------------------------------
create or replace function public.project_deliveries(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_deliveries(p_project) $$;
create or replace function public.delivery_projects() returns jsonb
language sql security invoker set search_path = '' as $$ select private.delivery_projects() $$;
create or replace function public.delivery_version_start(p_project uuid, p_ps uuid, p_kind text, p_title text, p_notes text, p_responsible uuid) returns uuid
language sql security invoker set search_path = '' as $$ select private.delivery_version_start(p_project, p_ps, p_kind, p_title, p_notes, p_responsible) $$;
create or replace function public.delivery_version_update(p_version uuid, p_title text, p_notes text, p_responsible uuid) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_version_update(p_version, p_title, p_notes, p_responsible) $$;
create or replace function public.delivery_file_add(p_version uuid, p_kind text, p_name text, p_path text, p_mime text, p_size bigint, p_url text) returns uuid
language sql security invoker set search_path = '' as $$ select private.delivery_file_add(p_version, p_kind, p_name, p_path, p_mime, p_size, p_url) $$;
create or replace function public.delivery_file_remove(p_file uuid) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_file_remove(p_file) $$;
create or replace function public.delivery_version_discard(p_version uuid) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_version_discard(p_version) $$;
create or replace function public.delivery_version_publish(p_version uuid) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_version_publish(p_version) $$;
create or replace function public.delivery_request_revision(p_project uuid, p_ps uuid, p_items text[], p_notes text) returns int
language sql security invoker set search_path = '' as $$ select private.delivery_request_revision(p_project, p_ps, p_items, p_notes) $$;
create or replace function public.delivery_approve(p_project uuid, p_ps uuid, p_note text) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_approve(p_project, p_ps, p_note) $$;
create or replace function public.delivery_extra_request(p_project uuid, p_ps uuid, p_kind text, p_reason text, p_amount numeric) returns uuid
language sql security invoker set search_path = '' as $$ select private.delivery_extra_request(p_project, p_ps, p_kind, p_reason, p_amount) $$;
create or replace function public.delivery_extra_decide(p_id uuid, p_approve boolean, p_note text) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_extra_decide(p_id, p_approve, p_note) $$;
create or replace function public.delivery_settings_list() returns jsonb
language sql security invoker set search_path = '' as $$ select private.delivery_settings_list() $$;
create or replace function public.delivery_settings_save(p_service uuid, p_enabled boolean, p_included int, p_codes text[]) returns void
language sql security invoker set search_path = '' as $$ select private.delivery_settings_save(p_service, p_enabled, p_included, p_codes) $$;
create or replace function public.revisions_overview(p_month date, p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.revisions_overview(p_month, p_tenant) $$;
create or replace function public.revisions_person(p_profile uuid, p_month date) returns jsonb
language sql security invoker set search_path = '' as $$ select private.revisions_person(p_profile, p_month) $$;

revoke all on function
  private.delivery_rules(uuid), private.can_work_delivery(uuid), private.can_decide_extra(uuid, uuid), private.delivery_calc(uuid),
  private.delivery_creation_responsible(uuid), private.delivery_ensure(uuid, uuid), private.delivery_service_name(public.project_deliveries),
  private.notify_project_clients(uuid, text, text, text, text, uuid, jsonb), private.notify_people(uuid[], uuid, text, text, text, text, uuid, jsonb),
  private.delivery_version_json(public.delivery_versions, boolean), private.delivery_request_json(public.delivery_revision_requests, boolean),
  private.delivery_item_json(uuid, uuid, boolean), private.project_deliveries(uuid), private.delivery_projects(),
  private.delivery_check_responsible(uuid, uuid), private.delivery_version_start(uuid, uuid, text, text, text, uuid),
  private.delivery_draft_for_edit(uuid), private.delivery_version_update(uuid, text, text, uuid),
  private.delivery_file_add(uuid, text, text, text, text, bigint, text), private.delivery_file_remove(uuid),
  private.delivery_version_discard(uuid), private.delivery_version_publish(uuid), private.delivery_client_guard(uuid, uuid),
  private.delivery_request_revision(uuid, uuid, text[], text), private.delivery_approve(uuid, uuid, text),
  private.delivery_extra_apply(uuid), private.delivery_extra_request(uuid, uuid, text, text, numeric), private.delivery_extra_decide(uuid, boolean, text),
  private.delivery_settings_list(), private.delivery_settings_save(uuid, boolean, int, text[]),
  private.revisions_overview(date, uuid), private.revisions_person(uuid, date),
  private.delivery_file_readable(text, text), private.delivery_file_writable(text, text),
  public.project_deliveries(uuid), public.delivery_projects(), public.delivery_version_start(uuid, uuid, text, text, text, uuid),
  public.delivery_version_update(uuid, text, text, uuid), public.delivery_file_add(uuid, text, text, text, text, bigint, text),
  public.delivery_file_remove(uuid), public.delivery_version_discard(uuid), public.delivery_version_publish(uuid),
  public.delivery_request_revision(uuid, uuid, text[], text), public.delivery_approve(uuid, uuid, text),
  public.delivery_extra_request(uuid, uuid, text, text, numeric), public.delivery_extra_decide(uuid, boolean, text),
  public.delivery_settings_list(), public.delivery_settings_save(uuid, boolean, int, text[]),
  public.revisions_overview(date, uuid), public.revisions_person(uuid, date)
from public, anon;

grant execute on function
  private.delivery_rules(uuid), private.can_work_delivery(uuid), private.can_decide_extra(uuid, uuid), private.delivery_calc(uuid),
  private.delivery_creation_responsible(uuid), private.delivery_ensure(uuid, uuid), private.delivery_service_name(public.project_deliveries),
  private.notify_project_clients(uuid, text, text, text, text, uuid, jsonb), private.notify_people(uuid[], uuid, text, text, text, text, uuid, jsonb),
  private.delivery_version_json(public.delivery_versions, boolean), private.delivery_request_json(public.delivery_revision_requests, boolean),
  private.delivery_item_json(uuid, uuid, boolean), private.project_deliveries(uuid), private.delivery_projects(),
  private.delivery_check_responsible(uuid, uuid), private.delivery_version_start(uuid, uuid, text, text, text, uuid),
  private.delivery_draft_for_edit(uuid), private.delivery_version_update(uuid, text, text, uuid),
  private.delivery_file_add(uuid, text, text, text, text, bigint, text), private.delivery_file_remove(uuid),
  private.delivery_version_discard(uuid), private.delivery_version_publish(uuid), private.delivery_client_guard(uuid, uuid),
  private.delivery_request_revision(uuid, uuid, text[], text), private.delivery_approve(uuid, uuid, text),
  private.delivery_extra_apply(uuid), private.delivery_extra_request(uuid, uuid, text, text, numeric), private.delivery_extra_decide(uuid, boolean, text),
  private.delivery_settings_list(), private.delivery_settings_save(uuid, boolean, int, text[]),
  private.revisions_overview(date, uuid), private.revisions_person(uuid, date),
  private.delivery_file_readable(text, text), private.delivery_file_writable(text, text),
  public.project_deliveries(uuid), public.delivery_projects(), public.delivery_version_start(uuid, uuid, text, text, text, uuid),
  public.delivery_version_update(uuid, text, text, uuid), public.delivery_file_add(uuid, text, text, text, text, bigint, text),
  public.delivery_file_remove(uuid), public.delivery_version_discard(uuid), public.delivery_version_publish(uuid),
  public.delivery_request_revision(uuid, uuid, text[], text), public.delivery_approve(uuid, uuid, text),
  public.delivery_extra_request(uuid, uuid, text, text, numeric), public.delivery_extra_decide(uuid, boolean, text),
  public.delivery_settings_list(), public.delivery_settings_save(uuid, boolean, int, text[]),
  public.revisions_overview(date, uuid), public.revisions_person(uuid, date)
to authenticated;
