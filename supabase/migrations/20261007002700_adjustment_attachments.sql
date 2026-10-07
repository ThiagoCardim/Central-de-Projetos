-- =============================================================================
-- 0027 · Imagens anexadas ao pedido de ajuste
--
--   * Bucket privado "adjustment-files": caminho {projeto}/{pedido}/{arquivo}.
--     Lê quem é da equipe e vê o projeto; envia só quem fez o pedido (pendente).
--   * adjustment_requests.attachments: lista [{path, name, size, type}].
--   * Até 6 imagens (JPG, PNG ou WebP), 8 MB cada.
-- =============================================================================

alter table public.adjustment_requests add column attachments jsonb not null default '[]'::jsonb
  check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 6);

create or replace function private.adjustment_file_readable(p_project text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return private.is_staff() and private.can_view_project(p_project::uuid);
exception when others then return false;
end;
$$;

create or replace function private.adjustment_file_writable(p_project text, p_request text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return exists (select 1 from public.adjustment_requests r
                 where r.id = p_request::uuid and r.project_id = p_project::uuid
                   and r.status = 'pending' and r.requested_by = private.current_profile_id());
exception when others then return false;
end;
$$;
grant execute on function private.adjustment_file_readable(text), private.adjustment_file_writable(text, text) to authenticated;

create or replace function private.adjustment_set_attachments(p_request uuid, p_files jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.adjustment_requests;
  f jsonb;
  v_clean jsonb := '[]'::jsonb;
  v_prefix text;
  v_exists boolean;
begin
  select * into r from public.adjustment_requests where id = p_request for update;
  if r.id is null or r.requested_by is distinct from private.current_profile_id() then
    raise exception 'Pedido não encontrado' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then raise exception 'Só é possível anexar imagens enquanto o pedido aguarda aprovação' using errcode = '23514'; end if;
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' then raise exception 'Anexos inválidos' using errcode = '22023'; end if;
  if jsonb_array_length(p_files) > 6 then raise exception 'Anexe no máximo 6 imagens' using errcode = '23514'; end if;

  v_prefix := r.project_id::text || '/' || r.id::text || '/';
  for f in select * from jsonb_array_elements(p_files) loop
    if coalesce(f ->> 'path', '') not like v_prefix || '%' or (f ->> 'path') ~ '\.\.' then
      raise exception 'Arquivo fora do pedido' using errcode = '23514';
    end if;
    if coalesce(f ->> 'type', '') not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'Use imagens JPG, PNG ou WebP' using errcode = '23514';
    end if;
    -- No Supabase, confirma que o arquivo foi mesmo enviado.
    if to_regclass('storage.objects') is not null then
      execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
        into v_exists using 'adjustment-files', f ->> 'path';
      if not v_exists then raise exception 'Imagem não encontrada no armazenamento' using errcode = '23514'; end if;
    end if;
    v_clean := v_clean || jsonb_build_object('path', f ->> 'path', 'name', left(coalesce(nullif(f ->> 'name', ''), 'imagem'), 120),
                                             'size', coalesce((f ->> 'size')::bigint, 0), 'type', f ->> 'type');
  end loop;
  update public.adjustment_requests set attachments = v_clean where id = r.id;
end;
$$;

create or replace function public.adjustment_set_attachments(p_request uuid, p_files jsonb) returns void
language sql security invoker set search_path = '' as $$ select private.adjustment_set_attachments(p_request, p_files) $$;
revoke all on function private.adjustment_set_attachments(uuid, jsonb), public.adjustment_set_attachments(uuid, jsonb) from public, anon;
grant execute on function private.adjustment_set_attachments(uuid, jsonb), public.adjustment_set_attachments(uuid, jsonb) to authenticated;

-- Lista do projeto passa a trazer os anexos.
create or replace function private.project_adjustments(p_project uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by (x ->> 'status') = 'pending' desc, x ->> 'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', r.id, 'project_id', r.project_id, 'project_name', p.name, 'project_code', p.code,
      'task_id', r.task_id, 'task_name', t.name, 'task_status', t.status,
      'target_service', ts.name, 'from_service', fs.name,
      'complexity', r.complexity, 'complexity_label', c.label, 'requested_days', r.requested_days,
      'description', r.description, 'status', r.status, 'attachments', r.attachments,
      'requested_by', jsonb_build_object('id', rq.id, 'name', rq.name),
      'decided_by', case when dc.id is not null then jsonb_build_object('id', dc.id, 'name', dc.name) end,
      'decided_at', r.decided_at, 'decision_note', r.decision_note, 'approved_days', r.approved_days,
      'assignee', case when asg.id is not null then jsonb_build_object('id', asg.id, 'name', asg.name) end,
      'result', r.result, 'created_at', r.created_at,
      'approvers', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name)), '[]'::jsonb)
                      from public.profiles a where a.id = any (private.adjustment_approvers(r.id))),
      'can_decide', r.status = 'pending' and private.current_profile_id() = any (private.adjustment_approvers(r.id)),
      'can_cancel', r.status = 'pending' and r.requested_by = private.current_profile_id()
    ) as x
    from public.adjustment_requests r
    join public.projects p on p.id = r.project_id
    join public.project_tasks t on t.id = r.task_id
    join public.project_services tps on tps.id = r.target_project_service_id
    join public.services ts on ts.id = tps.service_id
    left join public.project_services fps on fps.id = r.from_project_service_id
    left join public.services fs on fs.id = fps.service_id
    join public.adjustment_complexities c on c.code = r.complexity
    join public.profiles rq on rq.id = r.requested_by
    left join public.profiles dc on dc.id = r.decided_by
    left join public.profiles asg on asg.id = r.assignee_id
    where (p_project is null or r.project_id = p_project)
      and private.is_staff() and private.can_view_project(r.project_id)
  ) q
$$;

-- Bucket privado (só existe no Supabase).
do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('adjustment-files', 'adjustment-files', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = 8388608,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

    execute $p$create policy adjustment_files_select on storage.objects for select to authenticated
      using (bucket_id = 'adjustment-files' and private.adjustment_file_readable((storage.foldername(name))[1]))$p$;
    execute $p$create policy adjustment_files_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'adjustment-files'
                  and private.adjustment_file_writable((storage.foldername(name))[1], (storage.foldername(name))[2]))$p$;
  end if;
end
$do$;
