-- =============================================================================
-- 0050 · Acessos do cliente por projeto
--
--   Cada pessoa do lado do cliente (contato com login) pode ver:
--     · todos os projetos do cliente (scope = 'all', como era até aqui), ou
--     · só os projetos escolhidos (scope = 'projects').
--   E tem um de dois níveis:
--     · decide (can_decide): aprova entregas, pede revisão, envia documentos e responde;
--     · acompanha: só vê o andamento, as entregas e baixa arquivos.
--   Quem vincula: liderança do projeto, gestão da unidade, CS e o contato
--   principal do cliente (este só dentro do que ele mesmo enxerga).
--   E-mail novo vira usuário cliente com convite (Edge Function admin-users);
--   e-mail que já é cliente só ganha o vínculo.
-- =============================================================================

alter table public.client_contacts
  add column scope      text not null default 'all' check (scope in ('all', 'projects')),
  add column can_decide boolean not null default true,
  add column invited_by uuid references public.profiles (id) on delete set null;

create table public.client_contact_projects (
  contact_id uuid not null references public.client_contacts (id),
  project_id uuid not null references public.projects (id),
  active     boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (contact_id, project_id)
);
create index client_contact_projects_project_idx on public.client_contact_projects (project_id) where active;
alter table public.client_contact_projects enable row level security;
revoke all on public.client_contact_projects from anon, authenticated;
create trigger client_contact_projects_audit after insert or update on public.client_contact_projects for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Cobertura: o contato vale para o projeto?
-- -----------------------------------------------------------------------------
create or replace function private.client_contact_covers(cc public.client_contacts, p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select cc.active and cc.profile_id is not null
     and exists (select 1 from public.projects p where p.id = p_project and p.client_id = cc.client_id)
     and (cc.scope = 'all' or exists (select 1 from public.client_contact_projects x
                                      where x.contact_id = cc.id and x.project_id = p_project and x.active))
$$;

-- Contato (do perfil) que dá acesso ao projeto; o que decide tem prioridade.
create or replace function private.client_contact_of(p_profile uuid, p_project uuid) returns public.client_contacts
language sql stable security definer set search_path = ''
as $$
  select cc.* from public.client_contacts cc join public.projects p on p.id = p_project and p.client_id = cc.client_id
  where cc.profile_id = p_profile and private.client_contact_covers(cc, p_project)
  order by cc.can_decide desc, cc.is_primary desc limit 1
$$;

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
      return (private.client_contact_of(me.id, p.id)).id is not null;
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
      return (private.client_contact_of(me.id, p.id)).id is not null;
    else return false;
  end case;
end;
$$;

-- Cliente que pode decidir no projeto (aprovar, pedir revisão, enviar documento, responder).
create or replace function private.client_decides(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.my_role() = 'client' and coalesce((private.client_contact_of(private.current_profile_id(), p_project)).can_decide, false)
$$;

-- Avisos ao cliente: só quem tem acesso ao projeto.
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
           where cc.client_id = p.client_id and pr.status = 'ativo' and private.client_contact_covers(cc, p.id) loop
    perform private.notify(coalesce(p.delivery_tenant_id, p.commercial_tenant_id), p_kind, p_title, p_body, p_entity_type, p_entity_id, p_data, null, r.profile_id);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- "Só acompanha" não decide
-- -----------------------------------------------------------------------------
create or replace function private.client_decide_guard(p_project uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.my_role() = 'client' and not private.client_decides(p_project) then
    raise exception 'Seu acesso a este projeto é para acompanhar. Quem aprova e envia é a pessoa responsável pelo projeto.'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function private.delivery_client_guard(p_project uuid, p_ps uuid) returns public.project_deliveries
language plpgsql security definer set search_path = ''
as $$
declare d public.project_deliveries;
begin
  if p_ps is null or not private.can_view_project(p_project) then raise exception 'Entrega não encontrada' using errcode = 'P0002'; end if;
  if private.my_role() is distinct from 'client' and not private.can_work_delivery(p_project) then
    raise exception 'Somente o cliente ou a equipe do projeto' using errcode = '42501';
  end if;
  perform private.client_decide_guard(p_project);
  d := private.delivery_ensure(p_project, p_ps);
  select * into d from public.project_deliveries where id = d.id for update;
  if not d.revisions_enabled then raise exception 'Este serviço não tem rodadas de revisão' using errcode = '23514'; end if;
  return d;
end;
$$;

create or replace function private.delivery_req_file_writable(p_project text, p_request text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return p_request::uuid is not null
     and private.can_view_project(p_project::uuid)
     and (private.client_decides(p_project::uuid) or (private.my_role() <> 'client' and private.can_work_delivery(p_project::uuid)))
     and not exists (select 1 from public.delivery_revision_requests r where r.id = p_request::uuid);
exception when others then return false;
end;
$$;

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
  perform private.client_decide_guard(d.project_id);
  if d.status = 'approved' then raise exception 'Este documento já foi aprovado pela equipe' using errcode = '23514'; end if;
  return d;
end;
$$;

create or replace function private.document_file_writable(p_project text, p_document text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return exists (select 1 from public.project_documents d
                 where d.id = p_document::uuid and d.project_id = p_project::uuid and d.removed_at is null and d.status <> 'approved'
                   and private.can_view_project(d.project_id)
                   and (private.client_decides(d.project_id) or (private.my_role() <> 'client' and private.can_work_delivery(d.project_id))));
exception when others then return false;
end;
$$;

create or replace function private.document_answer(p_project uuid, p_question uuid, p_answer boolean) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_view_project(p_project) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if not (private.my_role() = 'client' or private.can_work_delivery(p_project) or private.can_manage_documents(p_project)) then
    raise exception 'Somente o cliente ou a equipe do projeto respondem' using errcode = '42501';
  end if;
  perform private.client_decide_guard(p_project);
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

create or replace function private.project_documents(p_project uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  v_staff boolean := private.is_staff();
  w public.client_waits;
  v_client boolean := private.my_role() = 'client';
  v_decides boolean := private.client_decides(p_project);
  v_answer boolean := v_decides or (not v_client and (private.can_work_delivery(p_project) or private.can_manage_documents(p_project)));
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if p.status not in ('cancelled', 'completed') then perform private.documents_refresh(p.id); end if;
  select * into w from public.client_waits where project_id = p.id and source = 'documents' and closed_at is null;
  return jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'status', p.status),
    'is_client', v_client, 'is_staff', v_staff, 'can_decide', not v_client or v_decides,
    'can_upload', v_decides or (not v_client and private.can_work_delivery(p.id)),
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

create or replace function private.project_deliveries(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  v_staff boolean := private.is_staff();
  v_client boolean := private.my_role() = 'client';
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'status', p.status),
    'is_client', v_client, 'is_staff', v_staff,
    'can_decide', not v_client or private.client_decides(p.id),
    'can_work', private.can_work_delivery(p.id),
    'can_request_extra', v_staff,
    'items', (select coalesce(jsonb_agg(x.j || jsonb_build_object('can_decide_extra', v_staff and private.can_decide_extra(p.id, x.id))
                                        order by (x.j ->> 'sort')::int, x.j ->> 'name'), '[]'::jsonb)
              from (select ps.id, private.delivery_item_json(p.id, ps.id, v_staff) j
                    from public.project_services ps where ps.project_id = p.id and ps.active and ps.status <> 'cancelled') x),
    'general', private.delivery_item_json(p.id, null, v_staff));
end;
$$;

-- -----------------------------------------------------------------------------
-- Gestão dos acessos
-- -----------------------------------------------------------------------------
-- Guarda de perfis: além de quem gerencia usuários, aceita o usuário cliente criado
-- por client_access_add (marcado na transação com o e-mail autorizado).
create or replace function private.guard_profile_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  t_type public.tenant_type;
begin
  if new.role = 'global_admin' then
    select type into t_type from public.tenants where id = new.tenant_id;
    if t_type is distinct from 'franqueadora' then
      raise exception 'ADM Global deve pertencer à franqueadora' using errcode = '23514';
    end if;
  end if;

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

  if tg_op = 'INSERT' and new.role = 'client'
     and nullif(current_setting('youcon.client_access_email', true), '') = lower(new.email::text) then
    return new;
  end if;

  if (tg_op = 'INSERT' or new.role <> old.role or new.tenant_id <> old.tenant_id)
     and not private.can_grant_role(new.tenant_id, new.role) then
    raise exception 'Sem permissão para atribuir este papel nesta unidade' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Equipe: liderança do projeto, gestão da unidade e CS. Cliente: contato principal que decide.
create or replace function private.can_manage_client_access(p_project uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare cc public.client_contacts;
begin
  if not private.can_view_project(p_project) then return false; end if;
  if private.my_role() = 'client' then
    cc := private.client_contact_of(private.current_profile_id(), p_project);
    return cc.id is not null and cc.is_primary and cc.can_decide;
  end if;
  return private.can_manage_project(p_project)
      or private.current_profile_id() = any (private.project_leaders(p_project, null))
      or private.is_cs();
end;
$$;

create or replace function private.client_access_json(cc public.client_contacts, p_project uuid, p_manage boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', cc.id, 'profile_id', cc.profile_id, 'name', coalesce(pr.name, cc.name),
    'email', case when p_manage or cc.profile_id = private.current_profile_id() then coalesce(pr.email::text, cc.email::text) end,
    'relation', cc.contact_role, 'scope', cc.scope, 'can_decide', cc.can_decide, 'is_primary', cc.is_primary,
    'is_me', cc.profile_id = private.current_profile_id(),
    'status', case when pr.status <> 'ativo' then 'inactive' when pr.last_seen_at is null then 'pending' else 'active' end,
    'projects', case when cc.scope = 'projects' then (select count(*) from public.client_contact_projects x where x.contact_id = cc.id and x.active) end,
    'invited_by', (select x.name from public.profiles x where x.id = cc.invited_by),
    'can_edit', p_manage and cc.profile_id is distinct from private.current_profile_id()
                and (private.my_role() <> 'client' or not cc.is_primary))
  from public.profiles pr where pr.id = cc.profile_id
$$;

create or replace function private.project_client_access(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  v_manage boolean := private.can_manage_client_access(p_project);
  me public.client_contacts;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if private.my_role() = 'client' then me := private.client_contact_of(private.current_profile_id(), p.id); end if;
  return jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'client_name', (select c.name from public.clients c where c.id = p.client_id)),
    'can_manage', v_manage,
    'can_grant_all', v_manage and (private.my_role() <> 'client' or me.scope = 'all'),
    'other_projects', (select count(*) from public.projects x where x.client_id = p.client_id and x.id <> p.id and x.status <> 'cancelled'),
    'people', (select coalesce(jsonb_agg(private.client_access_json(cc, p.id, v_manage)
                 order by cc.is_primary desc, cc.can_decide desc, cc.created_at), '[]'::jsonb)
               from public.client_contacts cc where cc.client_id = p.client_id and private.client_contact_covers(cc, p.id)));
end;
$$;

-- Vincula uma pessoa ao projeto (ou a todos os projetos do cliente).
-- Retorna o que a Edge Function precisa para mandar o convite quando o e-mail é novo.
create or replace function private.client_access_add(p_project uuid, p_name text, p_email text, p_phone text, p_relation text,
                                                    p_all boolean, p_decide boolean) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  c public.clients;
  pr public.profiles;
  cc public.client_contacts;
  me public.client_contacts;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := trim(coalesce(p_name, ''));
  v_new boolean := false;
  v_rel text := nullif(left(trim(coalesce(p_relation, '')), 60), '');
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if not private.can_manage_client_access(p.id) then
    raise exception 'Somente a liderança do projeto, o CS, a administração ou o contato principal do cliente vinculam acessos' using errcode = '42501';
  end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then raise exception 'Informe um e-mail válido' using errcode = '23514'; end if;
  if private.my_role() = 'client' and coalesce(p_all, false) then
    me := private.client_contact_of(private.current_profile_id(), p.id);
    if me.scope <> 'all' then raise exception 'Você só pode dar acesso aos projetos que você acompanha' using errcode = '42501'; end if;
  end if;
  select * into c from public.clients where id = p.client_id;

  select * into pr from public.profiles where email = v_email;
  if pr.id is not null and pr.role <> 'client' then
    raise exception 'Este e-mail é de um usuário da equipe. Use outro e-mail para o acesso de cliente' using errcode = '23514';
  end if;
  if pr.id is not null and pr.status <> 'ativo' then
    raise exception 'Este acesso está desativado. Peça à administração para reativá-lo em Controle de Acessos' using errcode = '23514';
  end if;
  if pr.id is null then
    if length(v_name) < 2 then raise exception 'Informe o nome da pessoa' using errcode = '23514'; end if;
    -- Libera a guarda de perfis só para este cliente (o vínculo já foi autorizado acima).
    perform set_config('youcon.client_access_email', v_email, true);
    insert into public.profiles (tenant_id, name, email, role, client_type, phone, status, invited_by, invited_at)
    values (c.tenant_id, left(v_name, 120), v_email, 'client', c.client_type, nullif(trim(coalesce(p_phone, '')), ''), 'ativo',
            private.current_profile_id(), now())
    returning * into pr;
    v_new := true;
  end if;

  select * into cc from public.client_contacts where client_id = c.id and profile_id = pr.id;
  if cc.id is null then
    select * into cc from public.client_contacts where client_id = c.id and profile_id is null and lower(email::text) = v_email
     order by created_at limit 1;
  end if;
  if cc.id is not null and private.client_contact_covers(cc, p.id) and (cc.scope = 'all' or not coalesce(p_all, false)) then
    raise exception '% já tem acesso a este projeto', coalesce(pr.name, v_email) using errcode = '23505';
  end if;

  if cc.id is null then
    insert into public.client_contacts (client_id, profile_id, name, email, phone, contact_role, is_primary, scope, can_decide, invited_by)
    values (c.id, pr.id, pr.name, v_email, nullif(trim(coalesce(p_phone, '')), ''), v_rel,
            not exists (select 1 from public.client_contacts where client_id = c.id and is_primary and active),
            case when coalesce(p_all, false) then 'all' else 'projects' end, coalesce(p_decide, true), private.current_profile_id())
    returning * into cc;
  else
    -- Contato inativo volta só com o que foi pedido agora; ativo amplia o acesso.
    update public.client_contacts set profile_id = pr.id, active = true,
      scope = case when coalesce(p_all, false) then 'all' when active then scope else 'projects' end,
      -- Quem já decidia em outros projetos não perde a decisão por ganhar um projeto novo.
      can_decide = case when active then can_decide or coalesce(p_decide, true) else coalesce(p_decide, true) end,
      contact_role = coalesce(v_rel, contact_role),
      invited_by = coalesce(invited_by, private.current_profile_id())
    where id = cc.id
    returning * into cc;
  end if;
  if cc.scope = 'projects' then
    insert into public.client_contact_projects (contact_id, project_id, created_by)
    values (cc.id, p.id, private.current_profile_id())
    on conflict (contact_id, project_id) do update set active = true, updated_at = now();
  end if;

  if not v_new and pr.last_seen_at is not null then
    perform private.notify(coalesce(p.delivery_tenant_id, p.commercial_tenant_id), 'client_access_granted',
      'Você tem acesso a um novo projeto', p.name, 'projects', p.id, jsonb_build_object('project_id', p.id), null, pr.id);
  end if;
  perform private.log_audit('client_access_granted', 'client_contacts', cc.id, c.tenant_id,
    jsonb_build_object('project_id', p.id, 'profile_id', pr.id, 'scope', cc.scope, 'can_decide', cc.can_decide, 'new_user', v_new));
  return jsonb_build_object('contact_id', cc.id, 'profile_id', pr.id, 'email', pr.email, 'name', pr.name,
    'send_invite', pr.auth_user_id is null, 'new_user', v_new);
end;
$$;

create or replace function private.client_access_contact(p_project uuid, p_contact uuid) returns public.client_contacts
language plpgsql security definer set search_path = ''
as $$
declare cc public.client_contacts;
begin
  select * into cc from public.client_contacts where id = p_contact for update;
  if cc.id is null or not private.client_contact_covers(cc, p_project) then raise exception 'Acesso não encontrado' using errcode = 'P0002'; end if;
  if not private.can_manage_client_access(p_project) then
    raise exception 'Somente a liderança do projeto, o CS, a administração ou o contato principal do cliente alteram acessos' using errcode = '42501';
  end if;
  if cc.profile_id = private.current_profile_id() then raise exception 'Você não altera o seu próprio acesso' using errcode = '42501'; end if;
  if private.my_role() = 'client' and cc.is_primary then raise exception 'O contato principal é alterado pela equipe' using errcode = '42501'; end if;
  return cc;
end;
$$;

create or replace function private.client_access_update(p_project uuid, p_contact uuid, p_relation text, p_all boolean, p_decide boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cc public.client_contacts := private.client_access_contact(p_project, p_contact);
  me public.client_contacts;
begin
  if coalesce(p_all, false) and cc.scope <> 'all' and private.my_role() = 'client' then
    me := private.client_contact_of(private.current_profile_id(), p_project);
    if me.scope <> 'all' then raise exception 'Você só pode dar acesso aos projetos que você acompanha' using errcode = '42501'; end if;
  end if;
  if not coalesce(p_all, false) and cc.scope = 'all' then
    -- Passa a ver só este projeto.
    insert into public.client_contact_projects (contact_id, project_id, created_by)
    values (cc.id, p_project, private.current_profile_id())
    on conflict (contact_id, project_id) do update set active = true, updated_at = now();
  end if;
  update public.client_contacts set contact_role = nullif(left(trim(coalesce(p_relation, '')), 60), ''),
    scope = case when coalesce(p_all, false) then 'all' else 'projects' end,
    can_decide = coalesce(p_decide, can_decide)
  where id = cc.id;
  perform private.log_audit('client_access_changed', 'client_contacts', cc.id, null,
    jsonb_build_object('project_id', p_project, 'all', p_all, 'can_decide', p_decide));
end;
$$;

-- Remove o acesso a este projeto (ou a todos os projetos do cliente).
create or replace function private.client_access_remove(p_project uuid, p_contact uuid, p_all boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  cc public.client_contacts := private.client_access_contact(p_project, p_contact);
  p public.projects;
begin
  select * into p from public.projects where id = p_project;
  if coalesce(p_all, false) then
    update public.client_contacts set active = false where id = cc.id;
    update public.client_contact_projects set active = false, updated_at = now() where contact_id = cc.id and active;
  else
    if cc.scope = 'all' then
      -- Continua nos outros projetos do cliente, menos neste.
      insert into public.client_contact_projects (contact_id, project_id, created_by)
      select cc.id, x.id, private.current_profile_id() from public.projects x
       where x.client_id = cc.client_id and x.id <> p_project and x.status <> 'cancelled'
      on conflict (contact_id, project_id) do update set active = true, updated_at = now();
      update public.client_contacts set scope = 'projects' where id = cc.id;
    end if;
    update public.client_contact_projects set active = false, updated_at = now() where contact_id = cc.id and project_id = p_project;
    if not exists (select 1 from public.client_contact_projects where contact_id = cc.id and active) then
      update public.client_contacts set active = false where id = cc.id;
    end if;
  end if;
  perform private.log_audit('client_access_removed', 'client_contacts', cc.id, null, jsonb_build_object('project_id', p_project, 'all', p_all));
end;
$$;

-- Reenvio do convite (a Edge Function manda o e-mail).
create or replace function private.client_access_invite_info(p_project uuid, p_contact uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  cc public.client_contacts;
  pr public.profiles;
begin
  select * into cc from public.client_contacts where id = p_contact;
  if cc.id is null or not private.client_contact_covers(cc, p_project) then raise exception 'Acesso não encontrado' using errcode = 'P0002'; end if;
  if not private.can_manage_client_access(p_project) then raise exception 'Você não pode reenviar este convite' using errcode = '42501'; end if;
  select * into pr from public.profiles where id = cc.profile_id;
  if pr.status <> 'ativo' then raise exception 'Este acesso está desativado' using errcode = '23514'; end if;
  if pr.last_seen_at is not null then raise exception '% já entrou no portal. Se esqueceu a senha, use “Esqueci a senha” no login.', pr.name using errcode = '23514'; end if;
  return jsonb_build_object('profile_id', pr.id, 'email', pr.email, 'name', pr.name, 'has_auth', pr.auth_user_id is not null);
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos
-- -----------------------------------------------------------------------------
create or replace function public.project_client_access(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_client_access(p_project) $$;
create or replace function public.client_access_add(p_project uuid, p_name text, p_email text, p_phone text, p_relation text, p_all boolean, p_decide boolean) returns jsonb
language sql security invoker set search_path = '' as $$ select private.client_access_add(p_project, p_name, p_email, p_phone, p_relation, p_all, p_decide) $$;
create or replace function public.client_access_update(p_project uuid, p_contact uuid, p_relation text, p_all boolean, p_decide boolean) returns void
language sql security invoker set search_path = '' as $$ select private.client_access_update(p_project, p_contact, p_relation, p_all, p_decide) $$;
create or replace function public.client_access_remove(p_project uuid, p_contact uuid, p_all boolean) returns void
language sql security invoker set search_path = '' as $$ select private.client_access_remove(p_project, p_contact, p_all) $$;
create or replace function public.client_access_invite_info(p_project uuid, p_contact uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.client_access_invite_info(p_project, p_contact) $$;

revoke all on function
  private.client_contact_covers(public.client_contacts, uuid), private.client_contact_of(uuid, uuid), private.client_decides(uuid),
  private.client_decide_guard(uuid), private.can_manage_client_access(uuid), private.client_access_json(public.client_contacts, uuid, boolean),
  private.project_client_access(uuid), private.client_access_add(uuid, text, text, text, text, boolean, boolean),
  private.client_access_contact(uuid, uuid), private.client_access_update(uuid, uuid, text, boolean, boolean),
  private.client_access_remove(uuid, uuid, boolean), private.client_access_invite_info(uuid, uuid),
  public.project_client_access(uuid), public.client_access_add(uuid, text, text, text, text, boolean, boolean),
  public.client_access_update(uuid, uuid, text, boolean, boolean), public.client_access_remove(uuid, uuid, boolean),
  public.client_access_invite_info(uuid, uuid)
from public, anon;

grant execute on function
  private.client_contact_covers(public.client_contacts, uuid), private.client_contact_of(uuid, uuid), private.client_decides(uuid),
  private.client_decide_guard(uuid), private.can_manage_client_access(uuid), private.client_access_json(public.client_contacts, uuid, boolean),
  private.project_client_access(uuid), private.client_access_add(uuid, text, text, text, text, boolean, boolean),
  private.client_access_contact(uuid, uuid), private.client_access_update(uuid, uuid, text, boolean, boolean),
  private.client_access_remove(uuid, uuid, boolean), private.client_access_invite_info(uuid, uuid),
  public.project_client_access(uuid), public.client_access_add(uuid, text, text, text, text, boolean, boolean),
  public.client_access_update(uuid, uuid, text, boolean, boolean), public.client_access_remove(uuid, uuid, boolean),
  public.client_access_invite_info(uuid, uuid)
to authenticated;
