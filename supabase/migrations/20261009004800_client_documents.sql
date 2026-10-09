-- =============================================================================
-- 0048 · Documentos do cliente
--
--   Lista padrão (franqueadora): tipos de documento em ordem, obrigatórios ou não
--   para iniciar o desenvolvimento, valendo para todos os projetos ou só quando o
--   projeto contrata certos serviços.
--   Em cada projeto: a lista padrão aplicável + documentos extras pedidos pela
--   liderança (ex.: exigência de um órgão). A liderança também tira do projeto o
--   que não faz mais sentido.
--   O cliente envia (arquivo ou link), a equipe aprova ou pede reenvio.
--   Faltando obrigatório com o projeto em andamento: abre uma espera do cliente
--   ("Envio dos documentos obrigatórios") com prazo da unidade; vencida, empurra
--   o cronograma como as demais esperas. Fecha sozinha quando todos os
--   obrigatórios estiverem enviados.
-- =============================================================================

create table public.document_types (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) between 2 and 120),
  description   text check (description is null or length(description) <= 1000),
  required      boolean not null default false,
  sort_order    int not null default 0,
  service_codes text[] check (service_codes is null or cardinality(service_codes) between 1 and 50),
  active        boolean not null default true,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles (id) on delete set null,
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create index document_types_order_idx on public.document_types (sort_order) where active;

create table public.project_documents (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id),
  type_id        uuid references public.document_types (id),
  source         text not null check (source in ('standard', 'extra')),
  name           text not null check (length(trim(name)) between 2 and 120),
  description    text check (description is null or length(description) <= 1000),
  required       boolean not null default false,
  sort_order     int not null default 0,
  status         text not null default 'pending' check (status in ('pending', 'submitted', 'approved', 'rejected')),
  round          int not null default 1 check (round >= 1),
  submitted_at   timestamptz,
  submitted_by   uuid references public.profiles (id),
  reviewed_at    timestamptz,
  reviewed_by    uuid references public.profiles (id),
  reject_reason  text check (reject_reason is null or length(reject_reason) <= 1000),
  requested_by   uuid references public.profiles (id),
  removed_at     timestamptz,
  removed_by     uuid references public.profiles (id),
  removed_reason text check (removed_reason is null or length(removed_reason) <= 500),
  removed_auto   boolean not null default false,
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default now(),
  constraint project_documents_source_chk check ((source = 'standard') = (type_id is not null))
);
create unique index project_documents_type_uidx on public.project_documents (project_id, type_id) where type_id is not null;
create index project_documents_project_idx on public.project_documents (project_id, sort_order);
create trigger project_documents_touch before update on public.project_documents for each row execute function private.touch_updated_at();

create table public.project_document_files (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.project_documents (id),
  project_id   uuid not null references public.projects (id),
  round        int not null,
  kind         text not null check (kind in ('file', 'link')),
  name         text not null check (length(name) between 1 and 200),
  storage_path text,
  mime         text,
  size_bytes   bigint,
  url          text,
  on_behalf    boolean not null default false,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default clock_timestamp(),
  archived_at  timestamptz,
  constraint project_document_files_ref_chk check ((kind = 'file' and storage_path is not null) or (kind = 'link' and url is not null))
);
create index project_document_files_doc_idx on public.project_document_files (document_id, round);

alter table public.document_types enable row level security;
alter table public.project_documents enable row level security;
alter table public.project_document_files enable row level security;
revoke all on public.document_types, public.project_documents, public.project_document_files from anon, authenticated;
create trigger document_types_audit after insert or update on public.document_types for each row execute function private.audit_row();
create trigger project_documents_audit after insert or update on public.project_documents for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Espera do cliente para os documentos obrigatórios
-- -----------------------------------------------------------------------------
alter table public.client_wait_settings
  add column documents_days int not null default 5 check (documents_days between 1 and 30);

alter table public.client_waits drop constraint client_waits_source_check;
alter table public.client_waits add constraint client_waits_source_check check (source in ('delivery', 'task', 'documents'));
alter table public.client_waits drop constraint client_waits_ref_chk;
alter table public.client_waits add constraint client_waits_ref_chk check (
  (source = 'delivery' and delivery_id is not null) or (source = 'task' and task_id is not null) or source = 'documents');
create unique index client_waits_open_documents on public.client_waits (project_id) where closed_at is null and source = 'documents';

create or replace function private.client_docs_days(p_tenant uuid) returns int
language sql stable security definer set search_path = ''
as $$ select coalesce((select s.documents_days from public.client_wait_settings s where s.tenant_id = p_tenant), 5) $$;

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
  v_due := public.add_business_days(v_today + 1,
             case when p_source = 'documents' then private.client_docs_days(p.delivery_tenant_id) else r.days end,
             private.calendar_for_tenant(p.delivery_tenant_id));
  insert into public.client_waits (project_id, tenant_id, source, delivery_id, version_id, task_id, label, started_on, due_on, started_by)
  values (p.id, p.delivery_tenant_id, p_source, p_delivery, p_version, p_task, left(p_label, 200), v_today, v_due, private.current_profile_id())
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- A espera dos documentos fecha sozinha quando os obrigatórios chegam (não há "Cliente retornou").
create or replace function private.can_return_wait(w public.client_waits) returns boolean
language sql stable security definer set search_path = ''
as $$
  select w.source <> 'documents' and (
       private.can_edit_schedule(w.project_id)
    or private.current_profile_id() = any (private.project_leaders(w.project_id, null))
    or (w.source = 'task' and exists (select 1 from public.project_tasks t where t.id = w.task_id and t.responsible_user_id = private.current_profile_id()))
    or (w.source = 'delivery' and (
          exists (select 1 from public.delivery_versions v where v.id = w.version_id and v.responsible_id = private.current_profile_id())
          or private.delivery_creation_responsible((select d.project_service_id from public.project_deliveries d where d.id = w.delivery_id)) = private.current_profile_id())))
$$;

create or replace function private.client_wait_settings_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r record;
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  select * into r from private.client_wait_rules(p_tenant);
  return jsonb_build_object('tenant_id', p_tenant, 'enabled', r.enabled, 'days', r.days, 'documents_days', private.client_docs_days(p_tenant));
end;
$$;

create or replace function private.client_wait_settings_save(p_tenant uuid, p_enabled boolean, p_days int, p_documents_days int) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Somente a administração altera o prazo' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 15 then raise exception 'Prazo de 1 a 15 dias úteis' using errcode = '23514'; end if;
  if p_documents_days is null or p_documents_days < 1 or p_documents_days > 30 then
    raise exception 'Prazo dos documentos: de 1 a 30 dias úteis' using errcode = '23514';
  end if;
  insert into public.client_wait_settings (tenant_id, enabled, days, documents_days, updated_by, updated_at)
  values (p_tenant, coalesce(p_enabled, true), p_days, p_documents_days, private.current_profile_id(), now())
  on conflict (tenant_id) do update set enabled = excluded.enabled, days = excluded.days, documents_days = excluded.documents_days,
    updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- -----------------------------------------------------------------------------
-- Permissões
-- -----------------------------------------------------------------------------
-- Inclui/remove documentos do projeto: liderança do projeto e gestão da unidade.
create or replace function private.can_manage_documents(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_manage_project(p_project)
      or private.current_profile_id() = any (private.project_leaders(p_project, null))
$$;

-- -----------------------------------------------------------------------------
-- Lista do projeto (espelha a lista padrão) e espera do cliente
-- -----------------------------------------------------------------------------
create or replace function private.documents_ensure(p_project uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_codes text[];
begin
  v_codes := array(select s.code from public.project_services x join public.services s on s.id = x.service_id
                   where x.project_id = p_project and x.active and x.status <> 'cancelled');

  insert into public.project_documents (project_id, type_id, source, name, description, required, sort_order)
  select p_project, t.id, 'standard', t.name, t.description, t.required, t.sort_order
  from public.document_types t
  where t.active and (t.service_codes is null or t.service_codes && v_codes)
    and not exists (select 1 from public.project_documents d where d.project_id = p_project and d.type_id = t.id)
  on conflict do nothing;

  -- Nome, orientação, obrigatoriedade e ordem seguem a lista padrão.
  update public.project_documents d
     set name = t.name, description = t.description, required = t.required, sort_order = t.sort_order
    from public.document_types t
   where d.project_id = p_project and d.type_id = t.id
     and (d.name, d.description, d.required, d.sort_order) is distinct from (t.name, t.description, t.required, t.sort_order);

  -- Saiu da lista (tipo excluído ou serviço não contratado): sai do projeto se nada foi enviado.
  update public.project_documents d
     set removed_at = now(), removed_auto = true, removed_reason = 'Fora da lista padrão deste projeto'
    from public.document_types t
   where d.project_id = p_project and d.type_id = t.id and d.removed_at is null and d.status = 'pending'
     and (not t.active or not (t.service_codes is null or t.service_codes && v_codes))
     and not exists (select 1 from public.project_document_files f where f.document_id = d.id and f.archived_at is null);

  -- Voltou a valer: volta ao projeto (a remoção pela liderança é mantida).
  update public.project_documents d
     set removed_at = null, removed_auto = false, removed_reason = null
    from public.document_types t
   where d.project_id = p_project and d.type_id = t.id and d.removed_at is not null and d.removed_auto
     and t.active and (t.service_codes is null or t.service_codes && v_codes);
end;
$$;

create or replace function private.documents_sync_wait(p_project uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  v_missing int;
begin
  select count(*) into v_missing from public.project_documents
   where project_id = p_project and removed_at is null and required and status in ('pending', 'rejected');
  select * into w from public.client_waits where project_id = p_project and source = 'documents' and closed_at is null;
  if v_missing > 0 and w.id is null then
    perform private.client_wait_open(p_project, 'documents', null, null, null, 'Envio dos documentos obrigatórios');
  elsif v_missing = 0 and w.id is not null then
    perform private.client_wait_close(w.id, null, case when private.my_role() = 'client' then 'portal' else 'team' end, null);
  end if;
end;
$$;

create or replace function private.documents_refresh(p_project uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.documents_ensure(p_project);
  perform private.documents_sync_wait(p_project);
end;
$$;

-- Projeto começa (equipe definida): a lista entra e a espera abre se faltar obrigatório.
create or replace function private.documents_on_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'in_progress' and old.status is distinct from 'in_progress' then
    perform private.documents_refresh(new.id);
  end if;
  return new;
end;
$$;
create trigger projects_documents after update of status on public.projects
  for each row execute function private.documents_on_project();

-- Mudou a lista padrão: atualiza os projetos ativos.
create or replace function private.documents_refresh_all() returns void
language plpgsql security definer set search_path = ''
as $$
declare p uuid;
begin
  for p in select id from public.projects where status not in ('cancelled', 'completed') loop
    perform private.documents_refresh(p);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
create or replace function private.document_file_json(f public.project_document_files, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', f.id, 'round', f.round, 'kind', f.kind, 'name', f.name, 'path', f.storage_path, 'mime', f.mime,
    'size', f.size_bytes, 'url', f.url, 'created_at', f.created_at, 'on_behalf', f.on_behalf,
    'by', case when p_staff then (select x.name from public.profiles x where x.id = f.created_by) end,
    'mine', f.created_by = private.current_profile_id())
$$;

create or replace function private.document_json(d public.project_documents, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'source', d.source, 'name', d.name, 'description', d.description,
    'required', d.required, 'status', d.status, 'round', d.round, 'reject_reason', d.reject_reason,
    'submitted_at', d.submitted_at, 'reviewed_at', d.reviewed_at,
    'reviewed_by', case when p_staff then (select x.name from public.profiles x where x.id = d.reviewed_by) end,
    'requested_by', case when p_staff then (select x.name from public.profiles x where x.id = d.requested_by) end,
    'created_at', d.created_at,
    'removed_at', d.removed_at, 'removed_reason', case when p_staff then d.removed_reason end, 'removed_auto', d.removed_auto,
    'files', (select coalesce(jsonb_agg(private.document_file_json(f, p_staff) order by f.created_at), '[]'::jsonb)
              from public.project_document_files f where f.document_id = d.id and f.archived_at is null and f.round = d.round),
    'history', (select coalesce(jsonb_agg(private.document_file_json(f, p_staff) order by f.round desc, f.created_at), '[]'::jsonb)
                from public.project_document_files f where f.document_id = d.id and f.archived_at is null and f.round < d.round))
$$;

-- Progresso: % aprovado sobre os documentos pedidos; obrigatórios enviados para iniciar.
create or replace function private.documents_progress(p_project uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'total', count(*), 'approved', count(*) filter (where status = 'approved'),
    'submitted', count(*) filter (where status = 'submitted'),
    'rejected', count(*) filter (where status = 'rejected'),
    'pending', count(*) filter (where status = 'pending'),
    'required_total', count(*) filter (where required),
    'required_sent', count(*) filter (where required and status in ('submitted', 'approved')),
    'percent', case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'approved') / count(*))::int end)
  from public.project_documents where project_id = p_project and removed_at is null
$$;

create or replace function private.project_documents(p_project uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  v_staff boolean := private.is_staff();
  w public.client_waits;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if p.status not in ('cancelled', 'completed') then perform private.documents_refresh(p.id); end if;
  select * into w from public.client_waits where project_id = p.id and source = 'documents' and closed_at is null;
  return jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'status', p.status),
    'is_client', private.my_role() = 'client', 'is_staff', v_staff,
    'can_upload', private.my_role() = 'client' or private.can_work_delivery(p.id),
    'can_review', v_staff and private.can_work_delivery(p.id),
    'can_manage', v_staff and private.can_manage_documents(p.id),
    'progress', private.documents_progress(p.id),
    'wait', case when w.id is not null then private.client_wait_json(w, v_staff) end,
    'documents_days', private.client_docs_days(p.delivery_tenant_id),
    'items', (select coalesce(jsonb_agg(private.document_json(d, v_staff) order by d.sort_order, d.created_at), '[]'::jsonb)
              from public.project_documents d where d.project_id = p.id and d.removed_at is null),
    'removed', case when v_staff then
                 (select coalesce(jsonb_agg(private.document_json(d, true) order by d.removed_at desc), '[]'::jsonb)
                  from public.project_documents d where d.project_id = p.id and d.removed_at is not null and not d.removed_auto)
               else '[]'::jsonb end);
end;
$$;

-- Cliente: projetos com o progresso dos documentos.
create or replace function private.document_projects() returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare p uuid;
begin
  if private.my_role() is distinct from 'client' then raise exception 'Disponível para o cliente' using errcode = '42501'; end if;
  for p in select x.id from public.projects x where x.status not in ('cancelled', 'completed') and private.can_view_project(x.id) loop
    perform private.documents_refresh(p);
  end loop;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'code', x.code, 'status', x.status,
            'progress', private.documents_progress(x.id)) order by x.created_at desc), '[]'::jsonb)
          from public.projects x where x.status <> 'cancelled' and private.can_view_project(x.id)
            and exists (select 1 from public.project_documents d where d.project_id = x.id and d.removed_at is null));
end;
$$;

-- -----------------------------------------------------------------------------
-- Envio (cliente ou equipe em nome dele)
-- -----------------------------------------------------------------------------
create or replace function private.document_for_upload(p_document uuid) returns public.project_documents
language plpgsql security definer set search_path = ''
as $$
declare d public.project_documents;
begin
  select * into d from public.project_documents where id = p_document for update;
  if d.id is null or d.removed_at is not null or not private.can_view_project(d.project_id) then
    raise exception 'Documento não encontrado' using errcode = 'P0002';
  end if;
  if private.my_role() is distinct from 'client' and not private.can_work_delivery(d.project_id) then
    raise exception 'Somente o cliente ou a equipe do projeto enviam documentos' using errcode = '42501';
  end if;
  if d.status = 'approved' then raise exception 'Este documento já foi aprovado pela equipe' using errcode = '23514'; end if;
  return d;
end;
$$;

create or replace function private.document_file_add(p_document uuid, p_kind text, p_name text, p_path text, p_mime text, p_size bigint, p_url text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_documents := private.document_for_upload(p_document);
  p public.projects;
  v_id uuid;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_client boolean := private.my_role() = 'client';
begin
  if (select count(*) from public.project_document_files where document_id = d.id and round = d.round and archived_at is null) >= 30 then
    raise exception 'Limite de 30 arquivos por documento' using errcode = '23514';
  end if;
  if p_kind = 'file' then
    if p_path is null or p_path not like d.project_id::text || '/' || d.id::text || '/%' then
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
  insert into public.project_document_files (document_id, project_id, round, kind, name, storage_path, mime, size_bytes, url, on_behalf, created_by)
  values (d.id, d.project_id, d.round, p_kind, left(v_name, 200), case when p_kind = 'file' then p_path end, left(p_mime, 120), p_size,
          case when p_kind = 'link' then trim(p_url) end, not v_client, private.current_profile_id())
  returning id into v_id;

  if d.status in ('pending', 'rejected') then
    update public.project_documents set status = 'submitted', submitted_at = now(), submitted_by = private.current_profile_id(),
      reject_reason = case when status = 'rejected' then reject_reason end
    where id = d.id;
    select * into p from public.projects where id = d.project_id;
    if v_client then
      perform private.notify_people(private.project_leaders(p.id, null), p.delivery_tenant_id, 'document_submitted',
        'Documento enviado pelo cliente', p.name || ' · ' || d.name, 'project_documents', d.id, jsonb_build_object('project_id', p.id));
    end if;
    perform private.resolve_notifications('document_rejected', d.id);
    perform private.resolve_notifications('document_requested', d.id);
    perform private.documents_sync_wait(d.project_id);
  end if;
  return v_id;
end;
$$;

-- Tirar um arquivo do envio atual (antes da aprovação). Sem arquivos, o documento volta a pendente.
create or replace function private.document_file_remove(p_file uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.project_document_files;
  d public.project_documents;
begin
  select * into f from public.project_document_files where id = p_file and archived_at is null;
  if f.id is null then raise exception 'Arquivo não encontrado' using errcode = 'P0002'; end if;
  d := private.document_for_upload(f.document_id);
  if f.round <> d.round then raise exception 'Arquivos de envios anteriores ficam no histórico' using errcode = '23514'; end if;
  if private.my_role() = 'client' and f.created_by is distinct from private.current_profile_id() then
    raise exception 'Você só remove arquivos enviados por você' using errcode = '42501';
  end if;
  update public.project_document_files set archived_at = now() where id = f.id;
  if d.status = 'submitted' and not exists (select 1 from public.project_document_files x
                                            where x.document_id = d.id and x.round = d.round and x.archived_at is null) then
    update public.project_documents set status = case when d.round > 1 then 'rejected' else 'pending' end,
      submitted_at = null, submitted_by = null where id = d.id;
    perform private.documents_sync_wait(d.project_id);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Conferência pela equipe
-- -----------------------------------------------------------------------------
create or replace function private.document_review(p_document uuid, p_approve boolean, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_documents;
  p public.projects;
begin
  select * into d from public.project_documents where id = p_document for update;
  if d.id is null or d.removed_at is not null or not private.can_view_project(d.project_id) then
    raise exception 'Documento não encontrado' using errcode = 'P0002';
  end if;
  if not (private.is_staff() and private.can_work_delivery(d.project_id)) then
    raise exception 'Somente a equipe do projeto confere os documentos' using errcode = '42501';
  end if;
  select * into p from public.projects where id = d.project_id;
  if p_approve then
    if d.status <> 'submitted' then raise exception 'Só dá para aprovar um documento enviado' using errcode = '23514'; end if;
    update public.project_documents set status = 'approved', reviewed_at = now(), reviewed_by = private.current_profile_id(), reject_reason = null
    where id = d.id;
  else
    if d.status not in ('submitted', 'approved') then raise exception 'Só dá para pedir reenvio de um documento enviado' using errcode = '23514'; end if;
    if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'Explique ao cliente o que precisa ser corrigido' using errcode = '23514'; end if;
    update public.project_documents set status = 'rejected', round = d.round + 1, reviewed_at = now(), reviewed_by = private.current_profile_id(),
      reject_reason = left(trim(p_reason), 1000), submitted_at = null, submitted_by = null
    where id = d.id;
    perform private.notify_project_clients(p.id, 'document_rejected', 'Precisamos de um novo envio: ' || d.name,
      p.name || ' · ' || left(trim(p_reason), 300), 'project_documents', d.id, jsonb_build_object('project_id', p.id));
  end if;
  perform private.resolve_notifications('document_submitted', d.id);
  perform private.documents_sync_wait(d.project_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Liderança: documentos extras e remoção no projeto
-- -----------------------------------------------------------------------------
create or replace function private.document_extra_add(p_project uuid, p_name text, p_description text, p_required boolean) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  v_id uuid;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if not (private.is_staff() and private.can_manage_documents(p.id)) then
    raise exception 'Somente a liderança do projeto pede documentos extras' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome do documento' using errcode = '23514'; end if;
  insert into public.project_documents (project_id, source, name, description, required, sort_order, requested_by)
  values (p.id, 'extra', left(trim(p_name), 120), nullif(left(trim(coalesce(p_description, '')), 1000), ''), coalesce(p_required, false),
          1000000 + (select count(*) from public.project_documents where project_id = p.id and source = 'extra')::int,
          private.current_profile_id())
  returning id into v_id;
  perform private.notify_project_clients(p.id, 'document_requested', 'Novo documento solicitado: ' || left(trim(p_name), 120),
    p.name || coalesce(' · ' || nullif(left(trim(coalesce(p_description, '')), 300), ''), ''), 'project_documents', v_id,
    jsonb_build_object('project_id', p.id));
  perform private.documents_sync_wait(p.id);
  return v_id;
end;
$$;

create or replace function private.document_extra_update(p_document uuid, p_name text, p_description text, p_required boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.project_documents;
begin
  select * into d from public.project_documents where id = p_document for update;
  if d.id is null or not private.can_view_project(d.project_id) then raise exception 'Documento não encontrado' using errcode = 'P0002'; end if;
  if not (private.is_staff() and private.can_manage_documents(d.project_id)) then
    raise exception 'Somente a liderança do projeto altera documentos extras' using errcode = '42501';
  end if;
  if d.source <> 'extra' then raise exception 'Documentos da lista padrão são alterados em Configurações' using errcode = '23514'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome do documento' using errcode = '23514'; end if;
  update public.project_documents set name = left(trim(p_name), 120), description = nullif(left(trim(coalesce(p_description, '')), 1000), ''),
    required = coalesce(p_required, false)
  where id = d.id;
  perform private.documents_sync_wait(d.project_id);
end;
$$;

create or replace function private.document_remove(p_document uuid, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.project_documents;
begin
  select * into d from public.project_documents where id = p_document for update;
  if d.id is null or not private.can_view_project(d.project_id) then raise exception 'Documento não encontrado' using errcode = 'P0002'; end if;
  if not (private.is_staff() and private.can_manage_documents(d.project_id)) then
    raise exception 'Somente a liderança do projeto remove documentos' using errcode = '42501';
  end if;
  if d.removed_at is not null then return; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Informe o motivo da remoção' using errcode = '23514'; end if;
  update public.project_documents set removed_at = now(), removed_by = private.current_profile_id(), removed_auto = false,
    removed_reason = left(trim(p_reason), 500)
  where id = d.id;
  perform private.resolve_notifications('document_submitted', d.id);
  perform private.resolve_notifications('document_rejected', d.id);
  perform private.resolve_notifications('document_requested', d.id);
  perform private.documents_sync_wait(d.project_id);
end;
$$;

create or replace function private.document_restore(p_document uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare d public.project_documents;
begin
  select * into d from public.project_documents where id = p_document for update;
  if d.id is null or not private.can_view_project(d.project_id) then raise exception 'Documento não encontrado' using errcode = 'P0002'; end if;
  if not (private.is_staff() and private.can_manage_documents(d.project_id)) then
    raise exception 'Somente a liderança do projeto devolve documentos à lista' using errcode = '42501';
  end if;
  update public.project_documents set removed_at = null, removed_by = null, removed_reason = null, removed_auto = false where id = d.id;
  perform private.documents_sync_wait(d.project_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Lista padrão (ADM Global)
-- -----------------------------------------------------------------------------
create or replace function private.document_types_list() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return jsonb_build_object('can_edit', private.is_global_admin(),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'required', t.required,
                'sort_order', t.sort_order, 'service_codes', to_jsonb(t.service_codes)) order by t.sort_order, t.created_at), '[]'::jsonb)
              from public.document_types t where t.active),
    'services', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'family', f.name)
                   order by f.sort_order, s.sort_order, s.name), '[]'::jsonb)
                 from public.services s join public.service_families f on f.id = s.family_id where s.active));
end;
$$;

create or replace function private.document_type_save(p_id uuid, p_name text, p_description text, p_required boolean, p_service_codes text[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_codes text[] := case when cardinality(p_service_codes) > 0 then p_service_codes end;
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome do documento' using errcode = '23514'; end if;
  if v_codes is not null and exists (select 1 from unnest(v_codes) c where not exists (select 1 from public.services s where s.code = c)) then
    raise exception 'Serviço não encontrado' using errcode = '23514';
  end if;
  if v_id is null then
    insert into public.document_types (name, description, required, sort_order, service_codes, created_by, updated_by)
    values (left(trim(p_name), 120), nullif(left(trim(coalesce(p_description, '')), 1000), ''), coalesce(p_required, false),
            coalesce((select max(sort_order) from public.document_types where active), 0) + 10, v_codes,
            private.current_profile_id(), private.current_profile_id())
    returning id into v_id;
  else
    update public.document_types set name = left(trim(p_name), 120), description = nullif(left(trim(coalesce(p_description, '')), 1000), ''),
      required = coalesce(p_required, false), service_codes = v_codes, updated_by = private.current_profile_id(), updated_at = now()
    where id = v_id and active;
    if not found then raise exception 'Documento não encontrado' using errcode = 'P0002'; end if;
  end if;
  perform private.documents_refresh_all();
  return v_id;
end;
$$;

-- Excluir da lista: some dos projetos onde ainda não foi enviado; envios já feitos ficam.
create or replace function private.document_type_delete(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  update public.document_types set active = false, archived_at = now(), updated_by = private.current_profile_id(), updated_at = now()
   where id = p_id and active;
  if not found then raise exception 'Documento não encontrado' using errcode = 'P0002'; end if;
  perform private.documents_refresh_all();
end;
$$;

create or replace function private.document_types_reorder(p_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if (select count(*) from public.document_types where active) <> cardinality(p_ids)
     or exists (select 1 from public.document_types t where t.active and not (t.id = any (p_ids))) then
    raise exception 'A lista mudou enquanto você ordenava. Recarregue a página.' using errcode = '23514';
  end if;
  update public.document_types t set sort_order = x.n * 10, updated_by = private.current_profile_id(), updated_at = now()
    from unnest(p_ids) with ordinality x(id, n)
   where t.id = x.id and t.sort_order <> x.n * 10;
  perform private.documents_refresh_all();
end;
$$;

-- -----------------------------------------------------------------------------
-- Armazenamento (até 50 MB por arquivo; maiores entram por link)
-- -----------------------------------------------------------------------------
create or replace function private.document_file_readable(p_project text, p_document text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return exists (select 1 from public.project_documents d
                 where d.id = p_document::uuid and d.project_id = p_project::uuid and private.can_view_project(d.project_id));
exception when others then return false;
end;
$$;

create or replace function private.document_file_writable(p_project text, p_document text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return exists (select 1 from public.project_documents d
                 where d.id = p_document::uuid and d.project_id = p_project::uuid and d.removed_at is null and d.status <> 'approved'
                   and private.can_view_project(d.project_id)
                   and (private.my_role() = 'client' or private.can_work_delivery(d.project_id)));
exception when others then return false;
end;
$$;

do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('project-documents', 'project-documents', false, 52428800)
    on conflict (id) do update set public = false, file_size_limit = 52428800;
    execute $p$create policy project_documents_select on storage.objects for select to authenticated
      using (bucket_id = 'project-documents' and private.document_file_readable((storage.foldername(name))[1], (storage.foldername(name))[2]))$p$;
    execute $p$create policy project_documents_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'project-documents' and private.document_file_writable((storage.foldername(name))[1], (storage.foldername(name))[2]))$p$;
  end if;
end;
$do$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos
-- -----------------------------------------------------------------------------
create or replace function public.project_documents(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_documents(p_project) $$;
create or replace function public.document_projects() returns jsonb
language sql security invoker set search_path = '' as $$ select private.document_projects() $$;
create or replace function public.document_file_add(p_document uuid, p_kind text, p_name text, p_path text, p_mime text, p_size bigint, p_url text) returns uuid
language sql security invoker set search_path = '' as $$ select private.document_file_add(p_document, p_kind, p_name, p_path, p_mime, p_size, p_url) $$;
create or replace function public.document_file_remove(p_file uuid) returns void
language sql security invoker set search_path = '' as $$ select private.document_file_remove(p_file) $$;
create or replace function public.document_review(p_document uuid, p_approve boolean, p_reason text) returns void
language sql security invoker set search_path = '' as $$ select private.document_review(p_document, p_approve, p_reason) $$;
create or replace function public.document_extra_add(p_project uuid, p_name text, p_description text, p_required boolean) returns uuid
language sql security invoker set search_path = '' as $$ select private.document_extra_add(p_project, p_name, p_description, p_required) $$;
create or replace function public.document_extra_update(p_document uuid, p_name text, p_description text, p_required boolean) returns void
language sql security invoker set search_path = '' as $$ select private.document_extra_update(p_document, p_name, p_description, p_required) $$;
create or replace function public.document_remove(p_document uuid, p_reason text) returns void
language sql security invoker set search_path = '' as $$ select private.document_remove(p_document, p_reason) $$;
create or replace function public.document_restore(p_document uuid) returns void
language sql security invoker set search_path = '' as $$ select private.document_restore(p_document) $$;
create or replace function public.document_types_list() returns jsonb
language sql security invoker set search_path = '' as $$ select private.document_types_list() $$;
create or replace function public.document_type_save(p_id uuid, p_name text, p_description text, p_required boolean, p_service_codes text[]) returns uuid
language sql security invoker set search_path = '' as $$ select private.document_type_save(p_id, p_name, p_description, p_required, p_service_codes) $$;
create or replace function public.document_type_delete(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.document_type_delete(p_id) $$;
create or replace function public.document_types_reorder(p_ids uuid[]) returns void
language sql security invoker set search_path = '' as $$ select private.document_types_reorder(p_ids) $$;
create or replace function public.client_wait_settings_save(p_tenant uuid, p_enabled boolean, p_days int, p_documents_days int) returns void
language sql security invoker set search_path = '' as $$ select private.client_wait_settings_save(p_tenant, p_enabled, p_days, p_documents_days) $$;

revoke all on function
  private.client_docs_days(uuid), private.client_wait_settings_save(uuid, boolean, int, int), private.can_manage_documents(uuid),
  private.documents_ensure(uuid), private.documents_sync_wait(uuid), private.documents_refresh(uuid), private.documents_refresh_all(),
  private.documents_on_project(), private.document_file_json(public.project_document_files, boolean),
  private.document_json(public.project_documents, boolean), private.documents_progress(uuid), private.project_documents(uuid),
  private.document_projects(), private.document_for_upload(uuid),
  private.document_file_add(uuid, text, text, text, text, bigint, text), private.document_file_remove(uuid),
  private.document_review(uuid, boolean, text), private.document_extra_add(uuid, text, text, boolean),
  private.document_extra_update(uuid, text, text, boolean), private.document_remove(uuid, text), private.document_restore(uuid),
  private.document_types_list(), private.document_type_save(uuid, text, text, boolean, text[]), private.document_type_delete(uuid),
  private.document_types_reorder(uuid[]), private.document_file_readable(text, text), private.document_file_writable(text, text),
  public.project_documents(uuid), public.document_projects(), public.document_file_add(uuid, text, text, text, text, bigint, text),
  public.document_file_remove(uuid), public.document_review(uuid, boolean, text), public.document_extra_add(uuid, text, text, boolean),
  public.document_extra_update(uuid, text, text, boolean), public.document_remove(uuid, text), public.document_restore(uuid),
  public.document_types_list(), public.document_type_save(uuid, text, text, boolean, text[]), public.document_type_delete(uuid),
  public.document_types_reorder(uuid[]), public.client_wait_settings_save(uuid, boolean, int, int)
from public, anon;

grant execute on function
  private.client_docs_days(uuid), private.client_wait_settings_save(uuid, boolean, int, int), private.can_manage_documents(uuid),
  private.document_file_json(public.project_document_files, boolean), private.document_json(public.project_documents, boolean),
  private.documents_progress(uuid), private.project_documents(uuid), private.document_projects(),
  private.document_file_add(uuid, text, text, text, text, bigint, text), private.document_file_remove(uuid),
  private.document_review(uuid, boolean, text), private.document_extra_add(uuid, text, text, boolean),
  private.document_extra_update(uuid, text, text, boolean), private.document_remove(uuid, text), private.document_restore(uuid),
  private.document_types_list(), private.document_type_save(uuid, text, text, boolean, text[]), private.document_type_delete(uuid),
  private.document_types_reorder(uuid[]), private.document_file_readable(text, text), private.document_file_writable(text, text),
  public.project_documents(uuid), public.document_projects(), public.document_file_add(uuid, text, text, text, text, bigint, text),
  public.document_file_remove(uuid), public.document_review(uuid, boolean, text), public.document_extra_add(uuid, text, text, boolean),
  public.document_extra_update(uuid, text, text, boolean), public.document_remove(uuid, text), public.document_restore(uuid),
  public.document_types_list(), public.document_type_save(uuid, text, text, boolean, text[]), public.document_type_delete(uuid),
  public.document_types_reorder(uuid[]), public.client_wait_settings_save(uuid, boolean, int, int)
to authenticated;
