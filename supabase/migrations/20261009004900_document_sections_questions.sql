-- =============================================================================
-- 0049 · Documentos do cliente: seções, titular (PF/PJ) e perguntas ao cliente
--
--   Seções: a lista padrão é agrupada (ex.: "Documentação do proprietário"),
--   com ordem própria; os documentos são ordenados dentro de cada seção.
--   Titular: um documento pode valer só para pessoa física ou só para jurídica.
--   O titular vem do CPF/CNPJ do cliente; sem documento, B2C = física, B2B = jurídica.
--   Perguntas: um documento pode depender de uma resposta "Sim" do cliente
--   (ex.: "O imóvel fica em condomínio?"). Sem resposta, a pergunta aparece no
--   portal; enquanto houver obrigatório dependendo dela, conta como pendência.
--   Projetos já em andamento antes dos documentos no portal não ganham prazo
--   automático (a liderança pode ligar).
-- =============================================================================

create table public.document_sections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) between 2 and 120),
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

create table public.document_questions (
  id          uuid primary key default gen_random_uuid(),
  text        text not null check (length(trim(text)) between 5 and 200),
  help        text check (help is null or length(help) <= 500),
  active      boolean not null default true,
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);

create table public.project_document_answers (
  project_id  uuid not null references public.projects (id),
  question_id uuid not null references public.document_questions (id),
  answer      boolean not null,
  answered_by uuid references public.profiles (id),
  answered_at timestamptz not null default now(),
  primary key (project_id, question_id)
);

alter table public.document_sections enable row level security;
alter table public.document_questions enable row level security;
alter table public.project_document_answers enable row level security;
revoke all on public.document_sections, public.document_questions, public.project_document_answers from anon, authenticated;
create trigger project_document_answers_audit after insert or update on public.project_document_answers for each row execute function private.audit_row();

alter table public.document_types
  add column section_id  uuid references public.document_sections (id),
  add column holder      text check (holder in ('pf', 'pj')),
  add column question_id uuid references public.document_questions (id);

alter table public.project_documents add column section text;

-- Prazo automático dos documentos por projeto. Os já em andamento ficam sem (a liderança liga).
alter table public.projects add column documents_wait boolean not null default true;
update public.projects set documents_wait = false where status in ('in_progress', 'on_hold', 'completed');

-- -----------------------------------------------------------------------------
-- Regras
-- -----------------------------------------------------------------------------
create or replace function private.project_holder(p_project uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select case when c.document ~ '^[0-9]{14}$' then 'pj' when c.document ~ '^[0-9]{11}$' then 'pf'
              when coalesce(p.client_type, c.client_type) = 'b2b' then 'pj' else 'pf' end
  from public.projects p left join public.clients c on c.id = p.client_id
  where p.id = p_project
$$;

-- Tipos da lista padrão que valem para o projeto. p_ignore_questions: só serviço e titular.
create or replace function private.document_types_for(p_project uuid, p_ignore_questions boolean default false)
returns table (type_id uuid, section text, sort_order int)
language sql stable security definer set search_path = ''
as $$
  with codes as (select array(select s.code from public.project_services x join public.services s on s.id = x.service_id
                              where x.project_id = p_project and x.active and x.status <> 'cancelled') v),
       h as (select private.project_holder(p_project) v)
  select t.id, sec.name, (coalesce(sec.sort_order, 0) * 100000 + t.sort_order)::int
  from public.document_types t
  left join public.document_sections sec on sec.id = t.section_id
  cross join codes cross join h
  where t.active
    and (t.service_codes is null or t.service_codes && codes.v)
    and (t.holder is null or t.holder = h.v)
    and (p_ignore_questions or t.question_id is null
         or exists (select 1 from public.project_document_answers a
                    where a.project_id = p_project and a.question_id = t.question_id and a.answer))
$$;

create or replace function private.documents_ensure(p_project uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.project_documents (project_id, type_id, source, name, description, required, sort_order, section)
  select p_project, t.id, 'standard', t.name, t.description, t.required, f.sort_order, f.section
  from private.document_types_for(p_project) f join public.document_types t on t.id = f.type_id
  where not exists (select 1 from public.project_documents d where d.project_id = p_project and d.type_id = t.id)
  on conflict do nothing;

  -- Nome, orientação, obrigatoriedade, seção e ordem seguem a lista padrão.
  update public.project_documents d
     set name = t.name, description = t.description, required = t.required,
         sort_order = coalesce(sec.sort_order, 0) * 100000 + t.sort_order, section = sec.name
    from public.document_types t left join public.document_sections sec on sec.id = t.section_id
   where d.project_id = p_project and d.type_id = t.id
     and (d.name, d.description, d.required, d.sort_order, d.section)
         is distinct from (t.name, t.description, t.required, coalesce(sec.sort_order, 0) * 100000 + t.sort_order, sec.name);

  -- Deixou de valer (tipo excluído, serviço, titular ou resposta): sai se nada foi enviado.
  update public.project_documents d
     set removed_at = now(), removed_auto = true, removed_reason = 'Fora da lista padrão deste projeto'
   where d.project_id = p_project and d.type_id is not null and d.removed_at is null and d.status = 'pending'
     and not exists (select 1 from private.document_types_for(p_project) f where f.type_id = d.type_id)
     and not exists (select 1 from public.project_document_files f where f.document_id = d.id and f.archived_at is null);

  -- Voltou a valer: volta ao projeto (a remoção pela liderança é mantida).
  update public.project_documents d
     set removed_at = null, removed_auto = false, removed_reason = null
   where d.project_id = p_project and d.removed_at is not null and d.removed_auto
     and exists (select 1 from private.document_types_for(p_project) f where f.type_id = d.type_id);
end;
$$;

-- Perguntas que importam para o projeto (algum documento depende delas).
create or replace function private.document_questions_for(p_project uuid)
returns table (question_id uuid, has_required boolean)
language sql stable security definer set search_path = ''
as $$
  select t.question_id, bool_or(t.required)
  from private.document_types_for(p_project, true) f join public.document_types t on t.id = f.type_id
  join public.document_questions q on q.id = t.question_id and q.active
  where t.question_id is not null
    -- Removido pela liderança não conta.
    and not exists (select 1 from public.project_documents d where d.project_id = p_project and d.type_id = t.id
                    and d.removed_at is not null and not d.removed_auto)
  group by t.question_id
$$;

create or replace function private.documents_sync_wait(p_project uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  w public.client_waits;
  v_missing int;
  v_on boolean;
begin
  select count(*) into v_missing from public.project_documents
   where project_id = p_project and removed_at is null and required and status in ('pending', 'rejected');
  -- Pergunta sem resposta com obrigatório dependendo dela também é pendência do cliente.
  v_missing := v_missing + (select count(*) from private.document_questions_for(p_project) q
                            where q.has_required and not exists (select 1 from public.project_document_answers a
                                                                 where a.project_id = p_project and a.question_id = q.question_id));
  select documents_wait into v_on from public.projects where id = p_project;
  select * into w from public.client_waits where project_id = p_project and source = 'documents' and closed_at is null;
  if v_missing > 0 and w.id is null and v_on then
    perform private.client_wait_open(p_project, 'documents', null, null, null, 'Envio dos documentos obrigatórios');
  elsif v_missing = 0 and w.id is not null then
    perform private.client_wait_close(w.id, null, case when private.my_role() = 'client' then 'portal' else 'team' end, null);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
create or replace function private.document_json(d public.project_documents, p_staff boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', d.id, 'source', d.source, 'name', d.name, 'description', d.description, 'section', d.section,
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

create or replace function private.project_documents(p_project uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  v_staff boolean := private.is_staff();
  w public.client_waits;
  v_answer boolean := private.my_role() = 'client' or private.can_work_delivery(p_project) or private.can_manage_documents(p_project);
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
    'holder', private.project_holder(p.id),
    'documents_wait', p.documents_wait,
    'progress', private.documents_progress(p.id),
    'wait', case when w.id is not null then private.client_wait_json(w, v_staff) end,
    'documents_days', private.client_docs_days(p.delivery_tenant_id),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'text', q.text, 'help', q.help, 'required', f.has_required,
                    'answer', a.answer, 'answered_at', a.answered_at, 'can_answer', v_answer and p.status not in ('cancelled', 'completed'),
                    'answered_by', case when v_staff then (select x.name from public.profiles x where x.id = a.answered_by) end)
                    order by q.created_at), '[]'::jsonb)
                  from private.document_questions_for(p.id) f join public.document_questions q on q.id = f.question_id
                  left join public.project_document_answers a on a.project_id = p.id and a.question_id = q.id),
    'items', (select coalesce(jsonb_agg(private.document_json(d, v_staff) order by d.sort_order, d.created_at), '[]'::jsonb)
              from public.project_documents d where d.project_id = p.id and d.removed_at is null),
    'removed', case when v_staff then
                 (select coalesce(jsonb_agg(private.document_json(d, true) order by d.removed_at desc), '[]'::jsonb)
                  from public.project_documents d where d.project_id = p.id and d.removed_at is not null and not d.removed_auto)
               else '[]'::jsonb end);
end;
$$;

-- -----------------------------------------------------------------------------
-- Respostas e prazo por projeto
-- -----------------------------------------------------------------------------
create or replace function private.document_answer(p_project uuid, p_question uuid, p_answer boolean) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_view_project(p_project) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if not (private.my_role() = 'client' or private.can_work_delivery(p_project) or private.can_manage_documents(p_project)) then
    raise exception 'Somente o cliente ou a equipe do projeto respondem' using errcode = '42501';
  end if;
  if p_answer is null then raise exception 'Responda sim ou não' using errcode = '23514'; end if;
  if not exists (select 1 from private.document_questions_for(p_project) q where q.question_id = p_question) then
    raise exception 'Pergunta não encontrada' using errcode = 'P0002';
  end if;
  insert into public.project_document_answers (project_id, question_id, answer, answered_by, answered_at)
  values (p_project, p_question, p_answer, private.current_profile_id(), now())
  on conflict (project_id, question_id) do update set answer = excluded.answer, answered_by = excluded.answered_by, answered_at = now();
  perform private.documents_refresh(p_project);
end;
$$;

create or replace function private.documents_wait_set(p_project uuid, p_on boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare w public.client_waits;
begin
  if not (private.is_staff() and private.can_manage_documents(p_project)) then
    raise exception 'Somente a liderança do projeto altera o prazo dos documentos' using errcode = '42501';
  end if;
  update public.projects set documents_wait = coalesce(p_on, true) where id = p_project;
  if not coalesce(p_on, true) then
    select * into w from public.client_waits where project_id = p_project and source = 'documents' and closed_at is null;
    if w.id is not null then perform private.client_wait_close(w.id, null, 'cancelled', 'Prazo dos documentos desligado pela liderança'); end if;
  end if;
  perform private.documents_sync_wait(p_project);
  perform private.log_audit('documents_wait_set', 'projects', p_project, null, jsonb_build_object('on', p_on));
end;
$$;

-- -----------------------------------------------------------------------------
-- Lista padrão: seções, perguntas e tipos
-- -----------------------------------------------------------------------------
create or replace function private.document_types_list() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Sem acesso' using errcode = '42501'; end if;
  return jsonb_build_object('can_edit', private.is_global_admin(),
    'sections', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'sort_order', s.sort_order) order by s.sort_order, s.created_at), '[]'::jsonb)
                 from public.document_sections s where s.active),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'text', q.text, 'help', q.help) order by q.created_at), '[]'::jsonb)
                  from public.document_questions q where q.active),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description, 'required', t.required,
                'sort_order', t.sort_order, 'service_codes', to_jsonb(t.service_codes), 'section_id', t.section_id, 'holder', t.holder,
                'question_id', t.question_id) order by t.sort_order, t.created_at), '[]'::jsonb)
              from public.document_types t where t.active),
    'services', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name, 'family', f.name)
                   order by f.sort_order, s.sort_order, s.name), '[]'::jsonb)
                 from public.services s join public.service_families f on f.id = s.family_id where s.active));
end;
$$;

create or replace function private.document_type_save(p_id uuid, p_name text, p_description text, p_required boolean, p_service_codes text[],
                                                      p_section uuid, p_holder text, p_question uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if p_holder is not null and p_holder not in ('pf', 'pj') then raise exception 'Titular inválido' using errcode = '23514'; end if;
  if p_section is not null and not exists (select 1 from public.document_sections where id = p_section and active) then
    raise exception 'Seção não encontrada' using errcode = 'P0002';
  end if;
  if p_question is not null and not exists (select 1 from public.document_questions where id = p_question and active) then
    raise exception 'Pergunta não encontrada' using errcode = 'P0002';
  end if;
  v_id := private.document_type_save(p_id, p_name, p_description, p_required, p_service_codes);
  update public.document_types set section_id = p_section, holder = p_holder, question_id = p_question where id = v_id;
  perform private.documents_refresh_all();
  return v_id;
end;
$$;

create or replace function private.document_section_save(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid := p_id;
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome da seção' using errcode = '23514'; end if;
  if v_id is null then
    insert into public.document_sections (name, sort_order, created_by)
    values (left(trim(p_name), 120), coalesce((select max(sort_order) from public.document_sections where active), 0) + 10, private.current_profile_id())
    returning id into v_id;
  else
    update public.document_sections set name = left(trim(p_name), 120) where id = v_id and active;
    if not found then raise exception 'Seção não encontrada' using errcode = 'P0002'; end if;
    perform private.documents_refresh_all();
  end if;
  return v_id;
end;
$$;

create or replace function private.document_section_delete(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if exists (select 1 from public.document_types where section_id = p_id and active) then
    raise exception 'Mova ou exclua os documentos desta seção antes' using errcode = '23514';
  end if;
  update public.document_sections set active = false, archived_at = now() where id = p_id and active;
  if not found then raise exception 'Seção não encontrada' using errcode = 'P0002'; end if;
end;
$$;

create or replace function private.document_sections_reorder(p_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if (select count(*) from public.document_sections where active) <> cardinality(p_ids)
     or exists (select 1 from public.document_sections s where s.active and not (s.id = any (p_ids))) then
    raise exception 'A lista mudou enquanto você ordenava. Recarregue a página.' using errcode = '23514';
  end if;
  update public.document_sections s set sort_order = x.n * 10
    from unnest(p_ids) with ordinality x(id, n) where s.id = x.id and s.sort_order <> x.n * 10;
  perform private.documents_refresh_all();
end;
$$;

create or replace function private.document_question_save(p_id uuid, p_text text, p_help text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid := p_id;
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if length(trim(coalesce(p_text, ''))) < 5 then raise exception 'Escreva a pergunta' using errcode = '23514'; end if;
  if v_id is null then
    insert into public.document_questions (text, help, created_by)
    values (left(trim(p_text), 200), nullif(left(trim(coalesce(p_help, '')), 500), ''), private.current_profile_id())
    returning id into v_id;
  else
    update public.document_questions set text = left(trim(p_text), 200), help = nullif(left(trim(coalesce(p_help, '')), 500), '')
     where id = v_id and active;
    if not found then raise exception 'Pergunta não encontrada' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function private.document_question_delete(p_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global altera a lista de documentos' using errcode = '42501'; end if;
  if exists (select 1 from public.document_types where question_id = p_id and active) then
    raise exception 'Há documentos que dependem desta pergunta. Altere-os antes' using errcode = '23514';
  end if;
  update public.document_questions set active = false, archived_at = now() where id = p_id and active;
  if not found then raise exception 'Pergunta não encontrada' using errcode = 'P0002'; end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos
-- -----------------------------------------------------------------------------
create or replace function public.document_answer(p_project uuid, p_question uuid, p_answer boolean) returns void
language sql security invoker set search_path = '' as $$ select private.document_answer(p_project, p_question, p_answer) $$;
create or replace function public.documents_wait_set(p_project uuid, p_on boolean) returns void
language sql security invoker set search_path = '' as $$ select private.documents_wait_set(p_project, p_on) $$;
create or replace function public.document_type_save(p_id uuid, p_name text, p_description text, p_required boolean, p_service_codes text[],
                                                     p_section uuid, p_holder text, p_question uuid) returns uuid
language sql security invoker set search_path = ''
as $$ select private.document_type_save(p_id, p_name, p_description, p_required, p_service_codes, p_section, p_holder, p_question) $$;
create or replace function public.document_section_save(p_id uuid, p_name text) returns uuid
language sql security invoker set search_path = '' as $$ select private.document_section_save(p_id, p_name) $$;
create or replace function public.document_section_delete(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.document_section_delete(p_id) $$;
create or replace function public.document_sections_reorder(p_ids uuid[]) returns void
language sql security invoker set search_path = '' as $$ select private.document_sections_reorder(p_ids) $$;
create or replace function public.document_question_save(p_id uuid, p_text text, p_help text) returns uuid
language sql security invoker set search_path = '' as $$ select private.document_question_save(p_id, p_text, p_help) $$;
create or replace function public.document_question_delete(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.document_question_delete(p_id) $$;

revoke all on function
  private.project_holder(uuid), private.document_types_for(uuid, boolean), private.document_questions_for(uuid),
  private.document_answer(uuid, uuid, boolean), private.documents_wait_set(uuid, boolean),
  private.document_type_save(uuid, text, text, boolean, text[], uuid, text, uuid),
  private.document_section_save(uuid, text), private.document_section_delete(uuid), private.document_sections_reorder(uuid[]),
  private.document_question_save(uuid, text, text), private.document_question_delete(uuid),
  public.document_answer(uuid, uuid, boolean), public.documents_wait_set(uuid, boolean),
  public.document_type_save(uuid, text, text, boolean, text[], uuid, text, uuid),
  public.document_section_save(uuid, text), public.document_section_delete(uuid), public.document_sections_reorder(uuid[]),
  public.document_question_save(uuid, text, text), public.document_question_delete(uuid)
from public, anon;

grant execute on function
  private.project_holder(uuid), private.document_answer(uuid, uuid, boolean), private.documents_wait_set(uuid, boolean),
  private.document_type_save(uuid, text, text, boolean, text[], uuid, text, uuid),
  private.document_section_save(uuid, text), private.document_section_delete(uuid), private.document_sections_reorder(uuid[]),
  private.document_question_save(uuid, text, text), private.document_question_delete(uuid),
  public.document_answer(uuid, uuid, boolean), public.documents_wait_set(uuid, boolean),
  public.document_type_save(uuid, text, text, boolean, text[], uuid, text, uuid),
  public.document_section_save(uuid, text), public.document_section_delete(uuid), public.document_sections_reorder(uuid[]),
  public.document_question_save(uuid, text, text), public.document_question_delete(uuid)
to authenticated;
