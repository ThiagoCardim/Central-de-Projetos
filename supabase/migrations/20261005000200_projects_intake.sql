-- =============================================================================
-- Portal de Projetos YouCon — Migration 0002: Entrada, projetos, distribuição,
-- equipe e avisos.
--
-- Fluxo: CRM → webhook → project_intakes → validação → clients → projects
--        → project_allocations → project_team → execução.
-- Lógica de processamento (RPCs) entra na Etapa 2; aqui fica o modelo + RLS.
-- =============================================================================

create type public.intake_status  as enum ('received', 'validated', 'processing', 'processed', 'error', 'ignored');
create type public.intake_kind    as enum ('new_project', 'additional_service');
create type public.project_status as enum ('awaiting_allocation', 'awaiting_team_assignment', 'in_progress', 'on_hold', 'completed', 'cancelled');

-- -----------------------------------------------------------------------------
-- Central de Entrada
-- -----------------------------------------------------------------------------
create table public.project_intakes (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null default 'pipefy',     -- pipefy | manual | outro CRM
  external_id         text not null,                      -- ex.: pipefy_card_id
  intake_kind         public.intake_kind not null default 'new_project',
  target_project_id   uuid,                               -- aditivo: projeto localizado (FK abaixo)
  target_external_id  text,                               -- aditivo: referência informada pelo CRM
  tenant_id           uuid references public.tenants(id) on delete restrict, -- tenant comercial
  origin_tenant_id    uuid references public.tenants(id) on delete restrict,
  client_name         text,
  client_email        extensions.citext,
  client_phone        text,
  client_document     text,
  client_type         public.client_type,
  project_name        text,
  project_type        text,
  services            jsonb not null default '[]'::jsonb, -- nomes/códigos como vieram do CRM
  resolved_services   jsonb,                              -- após expansão de pacotes/aliases
  contracted_at       date,
  contract_value      numeric(14,2) check (contract_value is null or contract_value >= 0),
  area_m2             numeric(10,2) check (area_m2 is null or area_m2 > 0),
  city                text,
  state               text,
  address             text,
  salesperson         text,
  notes               text,
  raw_payload         jsonb not null,                     -- payload original, imutável
  payload_hash        text,
  status              public.intake_status not null default 'received',
  validation_error    text,
  validation_details  jsonb,
  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  processed_by        uuid references public.profiles(id) on delete set null,
  created_client_id   uuid references public.clients(id) on delete set null,
  created_project_id  uuid,
  updated_at          timestamptz not null default now(),
  -- Idempotência: o mesmo evento do CRM nunca gera duas entradas.
  constraint project_intakes_source_external_uq unique (source, external_id)
);
create index project_intakes_status_idx on public.project_intakes (status, received_at desc);
create index project_intakes_tenant_idx on public.project_intakes (tenant_id, received_at desc);
create trigger project_intakes_touch before update on public.project_intakes
  for each row execute function private.touch_updated_at();

-- Payload original nunca muda após o recebimento.
create or replace function private.guard_intake_payload()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.raw_payload is distinct from old.raw_payload
     or new.external_id is distinct from old.external_id
     or new.source is distinct from old.source then
    raise exception 'Payload original da entrada é imutável' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger project_intakes_guard before update on public.project_intakes
  for each row execute function private.guard_intake_payload();

-- -----------------------------------------------------------------------------
-- Projetos
-- -----------------------------------------------------------------------------
create table public.projects (
  id                   uuid primary key default gen_random_uuid(),
  code                 text unique,                        -- código legível (ex.: YC-2026-0001)
  client_id            uuid not null references public.clients(id) on delete restrict,
  name                 text not null check (length(trim(name)) between 2 and 200),
  project_type         text,
  client_type          public.client_type not null,
  origin_tenant_id     uuid references public.tenants(id) on delete restrict,   -- quem gerou o lead
  commercial_tenant_id uuid not null references public.tenants(id) on delete restrict, -- quem vendeu
  delivery_tenant_id   uuid references public.tenants(id) on delete restrict,   -- quem executa (null até distribuir)
  city                 text,
  state                text,
  address              text,
  area_m2              numeric(10,2) check (area_m2 is null or area_m2 > 0),  -- nunca assumir valor
  status               public.project_status not null default 'awaiting_allocation',
  contracted_at        date,
  expected_deadline    date,
  started_at           timestamptz,
  completed_at         timestamptz,
  external_source      text,
  external_id          text,
  intake_id            uuid references public.project_intakes(id) on delete set null,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint projects_delivery_required_chk check (
    status in ('awaiting_allocation', 'cancelled') or delivery_tenant_id is not null
  )
);
create unique index projects_external_uidx on public.projects (external_source, external_id) where external_id is not null;
create index projects_delivery_idx   on public.projects (delivery_tenant_id, status);
create index projects_commercial_idx on public.projects (commercial_tenant_id, status);
create index projects_client_idx     on public.projects (client_id);
create trigger projects_touch before update on public.projects
  for each row execute function private.touch_updated_at();
create trigger projects_audit after insert or update or delete on public.projects
  for each row execute function private.audit_row();

alter table public.project_intakes
  add constraint project_intakes_target_project_fk foreign key (target_project_id) references public.projects(id) on delete set null,
  add constraint project_intakes_created_project_fk foreign key (created_project_id) references public.projects(id) on delete set null;

-- Código sequencial legível por ano.
create sequence public.project_code_seq;
create or replace function private.assign_project_code()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.code is null then
    new.code := 'YC-' || to_char(coalesce(new.contracted_at, current_date), 'YYYY') || '-'
             || lpad(nextval('public.project_code_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;
create trigger projects_code before insert on public.projects
  for each row execute function private.assign_project_code();

-- -----------------------------------------------------------------------------
-- Distribuição (catálogo configurável de métodos + histórico)
-- -----------------------------------------------------------------------------
create table public.allocation_methods (
  code        text primary key,
  name        text not null,
  description text,
  enabled     boolean not null default false,   -- métodos futuros ficam desabilitados
  created_at  timestamptz not null default now()
);
insert into public.allocation_methods (code, name, enabled) values
  ('automatic_headquarters', 'Automático — Franqueadora', true),
  ('manual',                 'Manual',                    true),
  ('territorial',            'Territorial',               false),
  ('round_robin',            'Rodízio',                   false),
  ('capacity',               'Capacidade',                false),
  ('performance',            'Performance',               false),
  ('marketplace',            'Marketplace',               false),
  ('lead_auction',           'Leilão de lead',            false),
  ('contract_auction',       'Leilão de contrato',        false),
  ('automatic',              'Distribuição automática',   false),
  ('hybrid',                 'Híbrido',                   false);

create type public.allocation_status as enum ('pending', 'offered', 'allocated', 'rejected', 'revoked');

create table public.project_allocations (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects(id) on delete cascade,
  origin_tenant_id     uuid references public.tenants(id) on delete restrict,
  commercial_tenant_id uuid references public.tenants(id) on delete restrict,
  delivery_tenant_id   uuid references public.tenants(id) on delete restrict,
  allocation_method    text not null references public.allocation_methods(code),
  allocation_status    public.allocation_status not null,
  allocated_by         uuid references public.profiles(id) on delete set null, -- null = sistema
  allocated_at         timestamptz,
  notes                text,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);
create index project_allocations_project_idx on public.project_allocations (project_id, created_at desc);
create trigger project_allocations_audit after insert on public.project_allocations
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Equipe do projeto — atribuição por FUNÇÃO
-- -----------------------------------------------------------------------------
create table public.project_roles (
  code        text primary key,
  name        text not null,
  sort_order  int not null default 0,
  required    boolean not null default false,  -- obrigatória para iniciar o projeto
  active      boolean not null default true
);
insert into public.project_roles (code, name, sort_order, required) values
  ('project_lead', 'Líder do Projeto', 0, true),
  ('architecture', 'Arquitetura',      10, false),
  ('engineering',  'Engenharia',       20, false),
  ('approval',     'Aprovação',        30, false),
  ('interiors',    'Interiores',       40, false),
  ('budget',       'Orçamentos',       50, false),
  ('construction', 'Obra',             60, false),
  ('development',  'B2B / Desenvolvimento', 70, false);

create table public.project_team (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete restrict,
  project_role    text not null references public.project_roles(code),
  employment_type public.employment_type,          -- snapshot no momento da atribuição
  assigned_by     uuid references public.profiles(id) on delete set null,
  assigned_at     timestamptz not null default now(),
  removed_by      uuid references public.profiles(id) on delete set null,
  removed_at      timestamptz,
  active          boolean not null default true
);
create unique index project_team_active_uidx on public.project_team (project_id, project_role, user_id) where active;
create index project_team_user_idx on public.project_team (user_id) where active;
create trigger project_team_audit after insert or update or delete on public.project_team
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Avisos (Home / sino)
-- -----------------------------------------------------------------------------
create table public.notifications (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  recipient_profile_id uuid references public.profiles(id) on delete cascade,
  recipient_role       public.user_role,             -- aviso para todos de um papel no tenant
  kind                 text not null,                -- ex.: project_awaiting_team, service_added
  title                text not null,
  body                 text,
  entity_type          text,
  entity_id            uuid,
  data                 jsonb not null default '{}'::jsonb,
  read_at              timestamptz,
  resolved_at          timestamptz,                  -- ação concluída (ex.: equipe atribuída)
  created_at           timestamptz not null default now(),
  constraint notifications_target_chk check (recipient_profile_id is not null or recipient_role is not null)
);
create index notifications_recipient_idx on public.notifications (recipient_profile_id, created_at desc);
create index notifications_role_idx on public.notifications (tenant_id, recipient_role, created_at desc);

-- =============================================================================
-- Permissões de projeto
-- =============================================================================

-- Pode visualizar o projeto.
--   ADM Global: todos.
--   ADM Unidade / Líder: projetos executados (delivery) ou vendidos (commercial) pela unidade.
--   Colaborador: somente onde está na equipe ativa.
--   Cliente: somente projetos do cliente ao qual seu perfil é contato.
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
    when 'collaborator' then
      return exists (select 1 from public.project_team t
                     where t.project_id = p.id and t.user_id = me.id and t.active);
    when 'client' then
      return exists (select 1 from public.client_contacts cc
                     where cc.client_id = p.client_id and cc.profile_id = me.id and cc.active);
  end case;
  return false;
end;
$$;

-- Pode gerenciar o projeto (equipe, cronograma, status). Somente a unidade executora.
create or replace function private.can_manage_project(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.my_role() in ('unit_admin','leader')
          and exists (select 1 from public.projects p
                      where p.id = p_project and p.delivery_tenant_id = private.current_tenant_id()))
$$;

create or replace function private.can_assign_team(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.can_manage_project(p_project) $$;

create or replace function private.can_edit_schedule(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.can_manage_project(p_project) $$;

-- Distribuir projetos entre unidades: ADM Global.
create or replace function private.can_distribute_projects() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_global_admin() $$;

-- Central de Entrada: ADM Global (todas) e ADM Unidade (as do seu tenant comercial).
create or replace function private.can_view_intake(p_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.my_role() = 'unit_admin' and p_tenant = private.current_tenant_id())
$$;

-- Diretório: estende can_view_profile para que clientes vejam a equipe dos seus projetos.
create or replace function private.can_view_person(target_profile uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.can_view_profile(target_profile) then return true; end if;
  if private.my_role() = 'client' then
    return exists (
      select 1 from public.project_team t
      where t.user_id = target_profile and t.active and private.can_view_project(t.project_id));
  end if;
  return false;
end;
$$;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.project_intakes     enable row level security;
alter table public.projects            enable row level security;
alter table public.allocation_methods  enable row level security;
alter table public.project_allocations enable row level security;
alter table public.project_roles       enable row level security;
alter table public.project_team        enable row level security;
alter table public.notifications       enable row level security;

-- Entradas: leitura por quem administra a entrada; escrita apenas por service_role/RPC.
create policy project_intakes_select on public.project_intakes for select to authenticated
  using (private.can_view_intake(tenant_id) or (tenant_id is null and private.is_global_admin()));

-- Projetos
create policy projects_select on public.projects for select to authenticated
  using (private.can_view_project(id));
create policy projects_update on public.projects for update to authenticated
  using (private.can_manage_project(id)) with check (private.can_manage_project(id));
-- INSERT e mudança de unidade apenas via RPCs da Etapa 2 (security definer).

-- Clientes: colaboradores e clientes enxergam o cliente dos projetos que podem ver.
create policy clients_select_by_project on public.clients for select to authenticated
  using (exists (select 1 from public.projects p where p.client_id = clients.id and private.can_view_project(p.id)));

-- Catálogos de referência: leitura para usuários ativos.
create policy allocation_methods_select on public.allocation_methods for select to authenticated
  using (private.current_profile_id() is not null);
create policy allocation_methods_update on public.allocation_methods for update to authenticated
  using (private.can_distribute_projects()) with check (private.can_distribute_projects());
create policy project_roles_select on public.project_roles for select to authenticated
  using (private.current_profile_id() is not null);
create policy project_roles_write on public.project_roles for all to authenticated
  using (private.is_global_admin()) with check (private.is_global_admin());

-- Histórico de distribuição: equipe interna que vê o projeto (cliente não vê dados administrativos).
create policy project_allocations_select on public.project_allocations for select to authenticated
  using (private.is_manager() and private.can_view_project(project_id));

-- Equipe: internos que veem o projeto; cliente vê a equipe (nomes/funções) do seu projeto.
create policy project_team_select on public.project_team for select to authenticated
  using (private.can_view_project(project_id));
create policy project_team_write on public.project_team for insert to authenticated
  with check (private.can_assign_team(project_id));
create policy project_team_update on public.project_team for update to authenticated
  using (private.can_assign_team(project_id)) with check (private.can_assign_team(project_id));

-- Avisos: do próprio usuário ou do seu papel no seu tenant.
create policy notifications_select on public.notifications for select to authenticated
  using (
    recipient_profile_id = private.current_profile_id()
    or (recipient_profile_id is null
        and recipient_role = private.my_role()
        and tenant_id = private.current_tenant_id())
  );
create policy notifications_mark_read on public.notifications for update to authenticated
  using (recipient_profile_id = private.current_profile_id()
         or (recipient_profile_id is null and recipient_role = private.my_role()
             and tenant_id = private.current_tenant_id()))
  with check (true);

-- Usuário só marca leitura; conteúdo do aviso é imutável para o app.
create or replace function private.guard_notification_update()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if auth.uid() is null then return new; end if;
  if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
    raise exception 'Somente a leitura do aviso pode ser alterada' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger notifications_guard before update on public.notifications
  for each row execute function private.guard_notification_update();

-- Diretório substitui leitura direta de perfis por clientes.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (private.can_view_person(id));

-- Visão segura de pessoas (sem dados trabalhistas) para exibir responsáveis.
create view public.people
with (security_invoker = true) as
  select id, tenant_id, name, avatar_url, role, status
  from public.profiles;

-- Privilégios
revoke all on public.project_intakes, public.projects, public.allocation_methods, public.project_allocations,
              public.project_roles, public.project_team, public.notifications from anon;
grant select on public.project_intakes, public.project_allocations to authenticated;
grant select, update on public.projects, public.allocation_methods, public.notifications to authenticated;
grant select, insert, update, delete on public.project_roles to authenticated;
grant select, insert, update on public.project_team to authenticated;
grant select on public.people to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
