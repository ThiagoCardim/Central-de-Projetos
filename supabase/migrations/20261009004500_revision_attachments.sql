-- =============================================================================
-- 0045 · Anexos no pedido de revisão
--
--   O cliente (ou a equipe, em nome dele) anexa prints, referências, inspirações
--   ou qualquer arquivo que ajude a entender a revisão. Os arquivos ficam em
--   project-deliveries/<projeto>/req/<pedido>/… e qualquer pessoa com acesso ao
--   projeto pode abrir. O envio acontece antes do registro do pedido (o id do
--   pedido é gerado no navegador); o registro só aceita arquivos dessa pasta.
-- =============================================================================

create table public.delivery_request_files (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.delivery_revision_requests (id),
  project_id   uuid not null references public.projects (id),
  name         text not null check (length(trim(name)) between 1 and 200),
  storage_path text not null,
  mime         text,
  size_bytes   bigint check (size_bytes is null or size_bytes >= 0),
  created_at   timestamptz not null default clock_timestamp()  -- preserva a ordem de envio
);
create index delivery_request_files_request_idx on public.delivery_request_files (request_id);
alter table public.delivery_request_files enable row level security;
revoke all on public.delivery_request_files from anon, authenticated;

-- Pedido com anexos (a versão de 4 parâmetros continua valendo, sem anexos).
create or replace function private.delivery_request_revision(p_project uuid, p_ps uuid, p_items text[], p_notes text, p_id uuid, p_files jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  d public.project_deliveries := private.delivery_client_guard(p_project, p_ps);
  c record;
  p public.projects;
  f jsonb;
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_items text[];
  v_round int;
  v_svc text;
  v_files int := jsonb_array_length(coalesce(p_files, '[]'::jsonb));
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
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' or v_files > 20 then
    raise exception 'Envie no máximo 20 anexos por revisão' using errcode = '23514';
  end if;
  if exists (select 1 from public.delivery_revision_requests where id = v_id) then
    raise exception 'Pedido já registrado' using errcode = '23505';
  end if;

  v_round := c.used + 1;
  insert into public.delivery_revision_requests (id, delivery_id, project_id, round, version_id, items, notes, requested_by, on_behalf, responsible_id)
  values (v_id, d.id, p_project, v_round, c.last_creation, v_items, nullif(trim(coalesce(p_notes, '')), ''),
          private.current_profile_id(), not v_client, c.last_creation_responsible);

  for f in select * from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) loop
    if coalesce(f ->> 'path', '') not like p_project::text || '/req/' || v_id::text || '/%' then
      raise exception 'Anexo inválido' using errcode = '23514';
    end if;
    insert into public.delivery_request_files (request_id, project_id, name, storage_path, mime, size_bytes)
    values (v_id, p_project, left(coalesce(nullif(trim(f ->> 'name'), ''), 'Anexo'), 200), f ->> 'path',
            left(f ->> 'mime', 120), nullif(f ->> 'size', '')::bigint);
  end loop;

  select * into p from public.projects where id = p_project;
  v_svc := private.delivery_service_name(d);
  perform private.notify_people(array_append(private.project_leaders(p.id, p_ps), c.last_creation_responsible),
    coalesce(p.delivery_tenant_id, p.commercial_tenant_id), 'delivery_revision', 'Revisão ' || v_round || ' solicitada: ' || v_svc,
    p.name || ' · ' || cardinality(v_items) || case when cardinality(v_items) = 1 then ' alteração' else ' alterações' end
      || case when v_files > 0 then ' e ' || v_files || case when v_files = 1 then ' anexo' else ' anexos' end else '' end
      || case when not v_client then ' (registrada pela equipe)' else '' end,
    'project_deliveries', d.id, jsonb_build_object('project_id', p.id));
  return v_round;
end;
$$;

create or replace function private.delivery_request_revision(p_project uuid, p_ps uuid, p_items text[], p_notes text) returns int
language sql security definer set search_path = ''
as $$ select private.delivery_request_revision(p_project, p_ps, p_items, p_notes, null::uuid, '[]'::jsonb) $$;

create or replace function private.delivery_request_json(q public.delivery_revision_requests, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', q.id, 'round', q.round, 'items', to_jsonb(q.items), 'notes', q.notes, 'on_behalf', q.on_behalf,
    'requested_by', (select x.name from public.profiles x where x.id = q.requested_by),
    'created_at', q.created_at, 'answered_at', q.answered_at, 'answered_version_id', q.answered_version_id, 'version_id', q.version_id,
    'responsible', case when p_staff then (select jsonb_build_object('id', x.id, 'name', x.name) from public.profiles x where x.id = q.responsible_id) end,
    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', 'file', 'name', f.name, 'path', f.storage_path, 'url', null,
                 'mime', f.mime, 'size', f.size_bytes) order by f.created_at), '[]'::jsonb)
              from public.delivery_request_files f where f.request_id = q.id))
$$;

-- Armazenamento: <projeto>/req/<pedido>/<arquivo>
create or replace function private.delivery_req_file_readable(p_project text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return private.can_view_project(p_project::uuid);
exception when others then return false;
end;
$$;

create or replace function private.delivery_req_file_writable(p_project text, p_request text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return p_request::uuid is not null
     and private.can_view_project(p_project::uuid)
     and (private.my_role() = 'client' or private.can_work_delivery(p_project::uuid))
     and not exists (select 1 from public.delivery_revision_requests r where r.id = p_request::uuid);
exception when others then return false;
end;
$$;

do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    execute $p$create policy project_deliveries_req_select on storage.objects for select to authenticated
      using (bucket_id = 'project-deliveries' and (storage.foldername(name))[2] = 'req'
             and private.delivery_req_file_readable((storage.foldername(name))[1]))$p$;
    execute $p$create policy project_deliveries_req_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'project-deliveries' and (storage.foldername(name))[2] = 'req'
                  and private.delivery_req_file_writable((storage.foldername(name))[1], (storage.foldername(name))[3]))$p$;
  end if;
end;
$do$;

create or replace function public.delivery_request_revision(p_project uuid, p_ps uuid, p_items text[], p_notes text, p_id uuid, p_files jsonb) returns int
language sql security invoker set search_path = ''
as $$ select private.delivery_request_revision(p_project, p_ps, p_items, p_notes, p_id, p_files) $$;

revoke all on function private.delivery_request_revision(uuid, uuid, text[], text, uuid, jsonb),
  private.delivery_req_file_readable(text), private.delivery_req_file_writable(text, text),
  public.delivery_request_revision(uuid, uuid, text[], text, uuid, jsonb) from public, anon;
grant execute on function private.delivery_request_revision(uuid, uuid, text[], text, uuid, jsonb),
  private.delivery_req_file_readable(text), private.delivery_req_file_writable(text, text),
  public.delivery_request_revision(uuid, uuid, text[], text, uuid, jsonb) to authenticated;
