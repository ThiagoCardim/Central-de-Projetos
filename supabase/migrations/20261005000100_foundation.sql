-- =============================================================================
-- Portal de Projetos YouCon — Migration 0001: Fundação
-- Tenants, perfis, clientes, contatos, auditoria, funções centrais de permissão,
-- bloqueio de usuários inativos (auth hook) e RLS.
--
-- Princípios:
--   * Toda regra de acesso vive no banco (schema `private`) e é reutilizada
--     pelas políticas RLS, pelas RPCs e pelas Edge Functions.
--   * Nenhuma tabela fica sem RLS.
--   * Auditoria é append-only (sem UPDATE/DELETE para nenhum papel de app).
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.tenant_type     as enum ('franqueadora', 'franquia');
create type public.record_status   as enum ('ativo', 'inativo');
create type public.user_role       as enum ('client', 'collaborator', 'leader', 'unit_admin', 'global_admin');
create type public.employment_type as enum ('clt', 'pj');
create type public.client_type     as enum ('b2c', 'b2b');

-- -----------------------------------------------------------------------------
-- Utilitário: updated_at
-- -----------------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------
create table public.tenants (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (length(trim(name)) between 2 and 120),
  type             public.tenant_type not null,
  status           public.record_status not null default 'ativo',
  parent_tenant_id uuid references public.tenants(id) on delete restrict,
  slug             text unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  city             text,
  state            text check (state is null or state ~ '^[A-Z]{2}$'),
  settings         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Franqueadora é a raiz; franquias pendem de uma franqueadora.
  constraint tenants_hierarchy_chk check (
    (type = 'franqueadora' and parent_tenant_id is null) or
    (type = 'franquia'     and parent_tenant_id is not null)
  )
);
-- Uma única franqueadora no sistema.
create unique index tenants_single_franqueadora_uidx on public.tenants ((type)) where type = 'franqueadora';
create trigger tenants_touch before update on public.tenants
  for each row execute function private.touch_updated_at();

comment on table public.tenants is 'Unidades (tenants). Franqueadora = raiz; cada franquia é um tenant isolado.';

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  tenant_id       uuid not null references public.tenants(id) on delete restrict,
  name            text not null check (length(trim(name)) between 2 and 120),
  email           extensions.citext not null unique,
  role            public.user_role not null,
  employment_type public.employment_type,
  client_type     public.client_type,
  status          public.record_status not null default 'ativo',
  phone           text,
  avatar_url      text,
  invited_by      uuid references public.profiles(id) on delete set null,
  invited_at      timestamptz,
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Colaborador sempre declara CLT/PJ.
  constraint profiles_collaborator_employment_chk check (role <> 'collaborator' or employment_type is not null),
  -- Cliente não tem vínculo trabalhista e sempre declara B2C/B2B.
  constraint profiles_client_type_chk check (
    (role = 'client' and client_type is not null and employment_type is null) or
    (role <> 'client' and client_type is null)
  )
);
create index profiles_tenant_idx on public.profiles (tenant_id, role, status);
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

comment on column public.profiles.employment_type is 'clt | pj — obrigatório para colaborador; opcional para líder/admin.';
comment on column public.profiles.client_type     is 'b2c | b2b — somente para role client; independente da role.';

-- -----------------------------------------------------------------------------
-- clients (cliente ≠ usuário: um cliente pode ter vários contatos/usuários)
-- -----------------------------------------------------------------------------
create table public.clients (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete restrict,
  name         text not null check (length(trim(name)) between 2 and 160),
  email        extensions.citext,
  phone        text,
  client_type  public.client_type not null,
  document     text,             -- CPF/CNPJ (somente dígitos)
  company_name text,             -- razão social (B2B)
  status       public.record_status not null default 'ativo',
  external_source text,
  external_id     text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint clients_document_digits_chk check (document is null or document ~ '^[0-9]{11}$|^[0-9]{14}$')
);
create index clients_tenant_idx on public.clients (tenant_id, status);
create unique index clients_tenant_document_uidx on public.clients (tenant_id, document) where document is not null;
create unique index clients_external_uidx on public.clients (external_source, external_id) where external_id is not null;
create trigger clients_touch before update on public.clients
  for each row execute function private.touch_updated_at();

-- Contatos do cliente (B2C: o próprio cliente; B2B: Empresa → Contatos).
create table public.client_contacts (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  profile_id   uuid references public.profiles(id) on delete set null, -- contato com acesso ao portal
  name         text not null,
  email        extensions.citext,
  phone        text,
  contact_role text,           -- ex.: "Diretor de Engenharia" (B2B)
  is_primary   boolean not null default false,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index client_contacts_profile_uidx on public.client_contacts (client_id, profile_id) where profile_id is not null;
create unique index client_contacts_primary_uidx on public.client_contacts (client_id) where is_primary and active;
create index client_contacts_profile_idx on public.client_contacts (profile_id) where active;
create trigger client_contacts_touch before update on public.client_contacts
  for each row execute function private.touch_updated_at();

-- -----------------------------------------------------------------------------
-- audit_logs (append-only)
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid references public.tenants(id) on delete set null,
  user_id     uuid references public.profiles(id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_tenant_idx on public.audit_logs (tenant_id, created_at desc);

-- =============================================================================
-- Funções centrais de identidade (private) — SECURITY DEFINER para não
-- recursar em RLS. Todas retornam NULL/false para usuário inativo.
-- =============================================================================

-- Perfil ativo do usuário autenticado (NULL se inexistente, inativo ou tenant inativo).
create or replace function private.current_profile()
returns public.profiles
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
  from public.profiles p
  join public.tenants t on t.id = p.tenant_id
  where p.auth_user_id = auth.uid()
    and p.status = 'ativo'
    and t.status = 'ativo'
  limit 1
$$;

create or replace function private.current_profile_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select (private.current_profile()).id $$;

create or replace function private.current_tenant_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select (private.current_profile()).tenant_id $$;

create or replace function private.my_role() returns public.user_role
language sql stable security definer set search_path = ''
as $$ select (private.current_profile()).role $$;

create or replace function private.is_global_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() = 'global_admin', false) $$;

-- Usuário interno (não-cliente) ativo.
create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() in ('collaborator','leader','unit_admin','global_admin'), false) $$;

-- Gestor da unidade (líder ou ADM unidade) ou ADM global.
create or replace function private.is_manager() returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.my_role() in ('leader','unit_admin','global_admin'), false) $$;

-- Nível hierárquico para regras de "não pode criar papel acima do seu".
create or replace function private.role_rank(r public.user_role) returns int
language sql immutable set search_path = ''
as $$
  select case r
    when 'client'       then 0
    when 'collaborator' then 1
    when 'leader'       then 2
    when 'unit_admin'   then 3
    when 'global_admin' then 4
  end
$$;

-- =============================================================================
-- Funções de permissão (fonte única de verdade — espelhadas no frontend apenas
-- para exibir/ocultar UI).
-- =============================================================================

-- Pode acessar dados operacionais de um tenant (staff do próprio tenant, ou ADM Global).
create or replace function private.can_access_tenant(target_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.is_staff() and private.current_tenant_id() = target_tenant)
$$;

-- Pode gerenciar usuários do tenant alvo.
create or replace function private.can_manage_users(target_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.my_role() = 'unit_admin' and private.current_tenant_id() = target_tenant)
$$;

-- Pode atribuir a role informada a um usuário (ADM Unidade nunca cria ADM Global).
create or replace function private.can_grant_role(target_tenant uuid, target_role public.user_role) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  t_type public.tenant_type;
begin
  if not private.can_manage_users(target_tenant) then
    return false;
  end if;
  if target_role = 'global_admin' then
    select type into t_type from public.tenants where id = target_tenant;
    -- Só ADM Global cria ADM Global, e somente na franqueadora.
    return private.is_global_admin() and t_type = 'franqueadora';
  end if;
  return private.role_rank(target_role) <= private.role_rank(private.my_role());
end;
$$;

-- Pode gerenciar configurações do tenant (ADM Unidade: o próprio; ADM Global: todos).
create or replace function private.can_manage_tenant(target_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin()
      or (private.my_role() = 'unit_admin' and private.current_tenant_id() = target_tenant)
$$;

-- Pode criar/editar unidades (franquias) e regras globais.
create or replace function private.can_manage_tenants() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_global_admin() $$;

-- Pode ver performance de um usuário. Nunca para PJ; nunca para cliente.
create or replace function private.can_view_performance(target_profile uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  me     public.profiles := private.current_profile();
  target public.profiles;
begin
  if me.id is null then return false; end if;
  select * into target from public.profiles where id = target_profile;
  if target.id is null or target.employment_type is distinct from 'clt' then
    return false;                                  -- PJ e não-colaboradores: sem performance
  end if;
  if me.role = 'global_admin' then return true; end if;
  if me.role in ('unit_admin','leader') and me.tenant_id = target.tenant_id then return true; end if;
  return me.id = target.id and me.employment_type = 'clt';  -- o próprio CLT
end;
$$;

-- Pode ver um perfil (diretório de pessoas).
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
  -- Gestores veem todos do próprio tenant (inclusive clientes).
  if me.role in ('unit_admin','leader') then return me.tenant_id = target.tenant_id; end if;
  -- Colaboradores veem a equipe interna do próprio tenant (não clientes).
  if me.role = 'collaborator' then
    return me.tenant_id = target.tenant_id and target.role <> 'client';
  end if;
  return false; -- clientes: estendido em 0002 (equipe dos seus projetos) via can_view_person
end;
$$;

-- Registro de auditoria (único ponto de escrita).
create or replace function private.log_audit(
  p_action text, p_entity_type text, p_entity_id uuid,
  p_tenant_id uuid default null, p_metadata jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, private.current_profile_id(), p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- Trigger genérico de auditoria. Deriva a ação semântica pelas colunas alteradas:
-- status → status_changed/deactivated/reactivated; responsible_user_id → responsible_changed;
-- datas previstas → rescheduled; delivery_tenant_id → unit_changed; demais → updated.
create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_changes jsonb := '{}'::jsonb;
  v_action text;
  v_tenant uuid;
  k text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if k not in ('updated_at','last_seen_at') and (v_new -> k) is distinct from (v_old -> k) then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return new; end if; -- nada relevante mudou
  end if;

  v_action := case tg_op
    when 'INSERT' then 'created'
    when 'DELETE' then 'deleted'
    else case
      when v_changes ? 'status' and v_new ->> 'status' = 'inativo' then 'deactivated'
      when v_changes ? 'status' and v_old ->> 'status' = 'inativo' then 'reactivated'
      when v_changes ? 'delivery_tenant_id'  then 'unit_changed'
      when v_changes ? 'responsible_user_id' then 'responsible_changed'
      when v_changes ? 'planned_start_date' or v_changes ? 'planned_end_date'
        or v_changes ? 'planned_duration_days' then 'rescheduled'
      when v_changes ? 'status' then 'status_changed'
      when v_changes ? 'role'   then 'role_changed'
      else 'updated'
    end
  end;

  v_tenant := coalesce(
    (v_row ->> 'tenant_id')::uuid,
    (v_row ->> 'delivery_tenant_id')::uuid,
    case when tg_table_name = 'tenants' then (v_row ->> 'id')::uuid end
  );

  insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
  values (
    v_tenant,
    private.current_profile_id(),
    v_action,
    tg_table_name,
    (v_row ->> 'id')::uuid,
    case tg_op
      when 'UPDATE' then jsonb_build_object('changes', v_changes)
      when 'INSERT' then jsonb_build_object('snapshot', v_new)
      else jsonb_build_object('snapshot', v_old)
    end
  );
  return coalesce(new, old);
end;
$$;

create trigger tenants_audit  after insert or update or delete on public.tenants  for each row execute function private.audit_row();
create trigger profiles_audit after insert or update or delete on public.profiles for each row execute function private.audit_row();
create trigger clients_audit  after insert or update or delete on public.clients  for each row execute function private.audit_row();
create trigger client_contacts_audit after insert or update or delete on public.client_contacts for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Guarda de integridade em profiles (defesa em profundidade, além do RLS).
-- -----------------------------------------------------------------------------
create or replace function private.guard_profile_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_type public.tenant_type;
begin
  -- ADM Global só pode pertencer à franqueadora.
  if new.role = 'global_admin' then
    select type into t_type from public.tenants where id = new.tenant_id;
    if t_type is distinct from 'franqueadora' then
      raise exception 'ADM Global deve pertencer à franqueadora' using errcode = '23514';
    end if;
  end if;

  -- Escritas via service_role (Edge Functions) já validaram permissão em RPC.
  if auth.uid() is null then return new; end if;

  if tg_op = 'UPDATE' then
    if old.id = private.current_profile_id()
       and (new.role <> old.role or new.status <> old.status or new.tenant_id <> old.tenant_id) then
      raise exception 'Você não pode alterar seu próprio papel, status ou unidade' using errcode = '42501';
    end if;
    if new.tenant_id <> old.tenant_id and not private.is_global_admin() then
      raise exception 'Somente ADM Global pode mover usuários entre unidades' using errcode = '42501';
    end if;
    if new.auth_user_id is distinct from old.auth_user_id then
      raise exception 'Vínculo de autenticação não pode ser alterado pelo app' using errcode = '42501';
    end if;
  end if;

  if (tg_op = 'INSERT' or new.role <> old.role or new.tenant_id <> old.tenant_id)
     and not private.can_grant_role(new.tenant_id, new.role) then
    raise exception 'Sem permissão para atribuir este papel nesta unidade' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function private.guard_profile_write();

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.tenants         enable row level security;
alter table public.profiles        enable row level security;
alter table public.clients         enable row level security;
alter table public.client_contacts enable row level security;
alter table public.audit_logs      enable row level security;

-- tenants: cada usuário vê seu tenant; ADM Global vê todos.
create policy tenants_select on public.tenants for select to authenticated
  using (private.is_global_admin() or id = private.current_tenant_id());
create policy tenants_insert on public.tenants for insert to authenticated
  with check (private.can_manage_tenants());
create policy tenants_update on public.tenants for update to authenticated
  using (private.can_manage_tenant(id)) with check (private.can_manage_tenant(id));
-- Sem DELETE: unidades são desativadas, nunca apagadas.

-- Unidade só altera o próprio nome/configurações permitidas; tipo/hierarquia/status são globais.
create or replace function private.guard_tenant_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or private.is_global_admin() then return new; end if;
  if new.type <> old.type or new.status <> old.status
     or new.parent_tenant_id is distinct from old.parent_tenant_id or new.slug is distinct from old.slug then
    raise exception 'Somente ADM Global altera tipo, status ou hierarquia da unidade' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tenants_guard before update on public.tenants
  for each row execute function private.guard_tenant_write();

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (private.can_view_profile(id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (private.can_manage_users(tenant_id));
create policy profiles_update on public.profiles for update to authenticated
  using (private.can_manage_users(tenant_id)) with check (private.can_manage_users(tenant_id));
-- Sem DELETE: usuários são desativados.

-- clients: gestores do tenant; colaboradores/clientes recebem acesso por projeto (0002).
create policy clients_select_managers on public.clients for select to authenticated
  using (private.is_manager() and private.can_access_tenant(tenant_id));
create policy clients_write on public.clients for insert to authenticated
  with check (private.is_manager() and private.can_access_tenant(tenant_id));
create policy clients_update on public.clients for update to authenticated
  using (private.is_manager() and private.can_access_tenant(tenant_id))
  with check (private.is_manager() and private.can_access_tenant(tenant_id));

-- client_contacts
create policy client_contacts_select on public.client_contacts for select to authenticated
  using (
    profile_id = private.current_profile_id()
    or exists (select 1 from public.clients c
               where c.id = client_id and private.is_manager() and private.can_access_tenant(c.tenant_id))
  );
create policy client_contacts_write on public.client_contacts for all to authenticated
  using (exists (select 1 from public.clients c
                 where c.id = client_id and private.is_manager() and private.can_access_tenant(c.tenant_id)))
  with check (exists (select 1 from public.clients c
                 where c.id = client_id and private.is_manager() and private.can_access_tenant(c.tenant_id)));

-- audit_logs: leitura para ADM (global: tudo; unidade: o próprio tenant). Escrita só por função.
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    private.is_global_admin()
    or (private.my_role() in ('unit_admin','leader') and tenant_id = private.current_tenant_id())
  );

-- Privilégios de tabela (RLS restringe as linhas; aqui restringimos operações).
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
revoke all on public.tenants, public.profiles, public.clients, public.client_contacts from anon;
grant select, insert, update on public.tenants, public.profiles, public.clients to authenticated;
grant select, insert, update, delete on public.client_contacts to authenticated;

-- =============================================================================
-- Auth hook: bloqueia emissão/renovação de token para usuário inativo, sem
-- perfil, ou de unidade inativa. Configurar em Authentication → Hooks →
-- "Customize Access Token (JWT) Claims" apontando para esta função.
-- =============================================================================
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_tenant_status public.record_status;
  v_claims jsonb;
begin
  select p.* into v_profile from public.profiles p where p.auth_user_id = (event ->> 'user_id')::uuid;
  if v_profile.id is null then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Acesso não liberado. Solicite um convite ao administrador da sua unidade.'));
  end if;
  select status into v_tenant_status from public.tenants where id = v_profile.tenant_id;
  if v_profile.status <> 'ativo' or v_tenant_status <> 'ativo' then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', 'Seu acesso está inativo. Fale com o administrador da sua unidade.'));
  end if;

  -- Claims informativos (o banco nunca confia neles para autorização).
  v_claims := coalesce(event -> 'claims', '{}'::jsonb)
    || jsonb_build_object('app_role', v_profile.role, 'tenant_id', v_profile.tenant_id, 'profile_id', v_profile.id);
  return jsonb_set(event, '{claims}', v_claims);
end;
$$;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant usage on schema public to supabase_auth_admin;
grant select on public.profiles, public.tenants to supabase_auth_admin;
create policy profiles_auth_hook on public.profiles for select to supabase_auth_admin using (true);
create policy tenants_auth_hook  on public.tenants  for select to supabase_auth_admin using (true);

-- Funções private: execução apenas por usuários autenticados (via RLS) e service_role.
revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
