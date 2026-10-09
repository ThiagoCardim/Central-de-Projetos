-- =============================================================================
-- 0043 · "Preciso de ajuda": cliente fala com o líder certo pelo WhatsApp
--
--   * O cliente escolhe o assunto; cada assunto aponta para um destino:
--     líder de Arquitetura, Engenharia ou Aprovação do projeto, ou o
--     Customer Success da unidade. O portal monta o link do WhatsApp com a
--     mensagem padrão (configurável) e registra o atendimento.
--   * O CS recebe o atendimento e acompanha até confirmar que foi resolvido.
--   * Configuração (ADM): WhatsApp das pessoas, WhatsApp do CS da unidade,
--     mensagem padrão; assuntos (ADM Global).
-- =============================================================================

alter table public.profiles add column whatsapp text check (whatsapp is null or whatsapp ~ '^[0-9]{10,15}$');

-- Normaliza para dígitos com DDI (Brasil por padrão).
create or replace function private.normalize_whatsapp(p text) returns text
language plpgsql immutable set search_path = ''
as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if d = '' then return null; end if;
  d := regexp_replace(d, '^0+', '');
  if length(d) in (10, 11) then d := '55' || d; end if;
  if length(d) < 12 or length(d) > 15 then raise exception 'WhatsApp inválido: informe DDD e número' using errcode = '23514'; end if;
  return d;
end;
$$;

create table public.support_categories (
  id          uuid primary key default gen_random_uuid(),
  label       text not null check (length(trim(label)) between 2 and 80),
  description text check (description is null or length(description) <= 200),
  target      text not null check (target in ('architecture', 'engineering', 'approval', 'cs')),
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
insert into public.support_categories (label, description, target, sort_order) values
  ('Projeto arquitetônico e interiores', 'Plantas, layout, acabamentos, imagens 3D', 'architecture', 10),
  ('Engenharia', 'Estrutural, elétrico, hidráulico e demais projetos técnicos', 'engineering', 20),
  ('Aprovação e documentação', 'Prefeitura, condomínio, órgãos, taxas e documentos', 'approval', 30),
  ('Prazos e andamento do projeto', 'Entender em que etapa o projeto está e as próximas entregas', 'cs', 40);
alter table public.support_categories enable row level security;
create policy support_categories_select on public.support_categories for select to authenticated using (true);
revoke all on public.support_categories from anon;
grant select on public.support_categories to authenticated;

create table public.support_settings (
  tenant_id        uuid primary key references public.tenants (id),
  cs_whatsapp      text check (cs_whatsapp is null or cs_whatsapp ~ '^[0-9]{12,15}$'),
  message_template text check (message_template is null or length(message_template) between 10 and 600),
  updated_by       uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now()
);
alter table public.support_settings enable row level security;
revoke all on public.support_settings from anon, authenticated;

create or replace function private.support_default_template() returns text
language sql immutable set search_path = ''
as $$ select 'Olá, {lider}! Aqui é {cliente}, do projeto {projeto}. Estou precisando de uma ajuda sobre {assunto}. {mensagem} Consegue me ajudar?' $$;

create table public.support_tickets (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id),
  tenant_id     uuid references public.tenants (id),
  client_id     uuid not null references public.profiles (id),
  category_id   uuid references public.support_categories (id),
  category      text not null,
  target        text not null,
  contact_id    uuid references public.profiles (id),
  contact_name  text,
  whatsapp      text,
  message       text check (message is null or length(message) <= 600),
  status        text not null default 'open' check (status in ('open', 'resolved', 'unresolved')),
  cs_note       text check (cs_note is null or length(cs_note) <= 1000),
  closed_by     uuid references public.profiles (id),
  closed_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index support_tickets_tenant_idx on public.support_tickets (tenant_id, status, created_at desc);
create trigger support_tickets_touch before update on public.support_tickets for each row execute function private.touch_updated_at();
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;

-- Quem atende cada destino no projeto.
create or replace function private.support_contact(p_project uuid, p_target text)
returns table (contact_id uuid, contact_name text, whatsapp text, prio int)
language sql stable security definer set search_path = ''
as $$
  select * from (
    select * from (
      select pr.id, pr.name, pr.whatsapp, 1
      from public.project_team t join public.profiles pr on pr.id = t.user_id
      where p_target <> 'cs' and t.project_id = p_project and t.active and t.project_role = 'lead_' || p_target and pr.status = 'ativo'
      order by (pr.whatsapp is not null) desc, t.assigned_at
      limit 1
    ) leader
    union all
    select null::uuid, 'Customer Success', s.cs_whatsapp, 2
    from public.projects p join public.support_settings s on s.tenant_id = coalesce(p.delivery_tenant_id, p.commercial_tenant_id)
    where p.id = p_project and s.cs_whatsapp is not null
  ) x order by 4
$$;

-- Opções para o cliente: assuntos e projetos.
create or replace function private.support_options() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.my_role() is distinct from 'client' then raise exception 'Disponível para o cliente' using errcode = '42501'; end if;
  return jsonb_build_object(
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'description', c.description, 'target', c.target)
                   order by c.sort_order, c.label), '[]'::jsonb) from public.support_categories c where c.active),
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code) order by p.created_at desc), '[]'::jsonb)
                 from public.projects p where p.status not in ('cancelled') and private.can_view_project(p.id)));
end;
$$;

-- Abre o atendimento: registra, avisa CS e líder e devolve o link do WhatsApp.
create or replace function private.support_open(p_project uuid, p_category uuid, p_message text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  me public.profiles := private.current_profile();
  p public.projects;
  c public.support_categories;
  k record;
  v_tpl text;
  v_text text;
  v_id uuid;
  v_tenant uuid;
  v_hq uuid;
  v_msg text := nullif(trim(left(coalesce(p_message, ''), 600)), '');
begin
  if me.role is distinct from 'client' then raise exception 'Disponível para o cliente' using errcode = '42501'; end if;
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  select * into c from public.support_categories where id = p_category and active;
  if c.id is null then raise exception 'Escolha o assunto' using errcode = '23514'; end if;
  v_tenant := coalesce(p.delivery_tenant_id, p.commercial_tenant_id);

  -- Líder da área; sem WhatsApp do líder, cai no CS da unidade.
  select * into k from private.support_contact(p.id, c.target) x where x.whatsapp is not null order by x.prio limit 1;
  if k.contact_name is null then select * into k from private.support_contact(p.id, c.target) x order by x.prio limit 1; end if;

  select coalesce(message_template, private.support_default_template()) into v_tpl from public.support_settings where tenant_id = v_tenant;
  v_tpl := coalesce(v_tpl, private.support_default_template());
  v_text := replace(replace(replace(replace(replace(v_tpl,
    '{lider}', case when k.contact_id is null then 'equipe YouCon' else split_part(k.contact_name, ' ', 1) end),
    '{cliente}', split_part(me.name, ' ', 1)),
    '{projeto}', p.name),
    '{assunto}', lower(c.label)),
    '{mensagem}', coalesce(v_msg || case when v_msg ~ '[.!?]$' then '' else '.' end, ''));
  v_text := regexp_replace(trim(v_text), '\s{2,}', ' ', 'g');

  insert into public.support_tickets (project_id, tenant_id, client_id, category_id, category, target, contact_id, contact_name, whatsapp, message)
  values (p.id, v_tenant, me.id, c.id, c.label, c.target, k.contact_id, k.contact_name, k.whatsapp, v_msg)
  returning id into v_id;

  perform private.notify(v_tenant, 'support_opened', 'Cliente pediu ajuda: ' || c.label,
    me.name || ' · ' || p.name || coalesce(' · ' || k.contact_name, ''), 'support_tickets', v_id,
    jsonb_build_object('project_id', p.id), array['customer_success']::public.user_role[], null);
  select id into v_hq from public.tenants where type = 'franqueadora' order by created_at limit 1;
  if v_hq is not null and v_hq is distinct from v_tenant then
    perform private.notify(v_hq, 'support_opened', 'Cliente pediu ajuda: ' || c.label,
      me.name || ' · ' || p.name || coalesce(' · ' || k.contact_name, ''), 'support_tickets', v_id,
      jsonb_build_object('project_id', p.id), array['customer_success']::public.user_role[], null);
  end if;
  if k.contact_id is not null then
    perform private.notify(v_tenant, 'support_leader', 'Cliente vai te chamar no WhatsApp',
      me.name || ' · ' || p.name || ' · ' || c.label || coalesce(': ' || v_msg, ''), 'projects', p.id, '{}'::jsonb, null, k.contact_id);
  end if;

  return jsonb_build_object('id', v_id, 'contact_name', k.contact_name, 'has_whatsapp', k.whatsapp is not null,
    'url', case when k.whatsapp is not null then 'https://wa.me/' || k.whatsapp || '?text=' || private.url_encode(v_text) end,
    'text', v_text);
end;
$$;

create or replace function private.url_encode(p text) returns text
language plpgsql immutable set search_path = ''
as $$
declare
  b bytea := convert_to(p, 'UTF8');
  out text := '';
  i int;
  ch int;
begin
  for i in 0 .. length(b) - 1 loop
    ch := get_byte(b, i);
    if (ch between 48 and 57) or (ch between 65 and 90) or (ch between 97 and 122) or ch in (45, 46, 95, 126) then
      out := out || chr(ch);
    else
      out := out || '%' || upper(lpad(to_hex(ch), 2, '0'));
    end if;
  end loop;
  return out;
end;
$$;

-- -----------------------------------------------------------------------------
-- Acompanhamento pelo CS (e gestão)
-- -----------------------------------------------------------------------------
create or replace function private.support_tickets_list() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.is_cs() or private.is_manager()) then raise exception 'Sem acesso aos atendimentos' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'project_id', t.project_id, 'project_name', p.name, 'project_code', p.code, 'client_name', cl.name,
      'requester', jsonb_build_object('id', rq.id, 'name', rq.name, 'phone', rq.phone, 'email', rq.email),
      'category', t.category, 'target', t.target, 'contact_name', t.contact_name, 'has_whatsapp', t.whatsapp is not null,
      'message', t.message, 'status', t.status, 'cs_note', t.cs_note, 'created_at', t.created_at, 'closed_at', t.closed_at,
      'closed_by', case when cb.id is not null then jsonb_build_object('id', cb.id, 'name', cb.name) end,
      'tenant_name', tn.name
    ) order by (t.status = 'open') desc, t.created_at desc), '[]'::jsonb)
    from public.support_tickets t
    join public.projects p on p.id = t.project_id
    left join public.clients cl on cl.id = p.client_id
    join public.profiles rq on rq.id = t.client_id
    left join public.profiles cb on cb.id = t.closed_by
    left join public.tenants tn on tn.id = t.tenant_id
    where private.can_view_project(t.project_id));
end;
$$;

create or replace function private.support_ticket_update(p_id uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare t public.support_tickets;
begin
  select * into t from public.support_tickets where id = p_id for update;
  if t.id is null or not (private.is_cs() or private.is_manager()) or not private.can_view_project(t.project_id) then
    raise exception 'Atendimento não encontrado' using errcode = 'P0002';
  end if;
  if p_status not in ('open', 'resolved', 'unresolved') then raise exception 'Situação inválida' using errcode = '23514'; end if;
  update public.support_tickets set status = p_status, cs_note = coalesce(nullif(trim(p_note), ''), cs_note),
    closed_by = case when p_status = 'open' then null else private.current_profile_id() end,
    closed_at = case when p_status = 'open' then null else now() end
  where id = t.id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Configuração (ADM)
-- -----------------------------------------------------------------------------
create or replace function private.support_settings_get(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare s public.support_settings;
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  select * into s from public.support_settings where tenant_id = p_tenant;
  return jsonb_build_object(
    'tenant_id', p_tenant, 'cs_whatsapp', s.cs_whatsapp,
    'message_template', coalesce(s.message_template, private.support_default_template()),
    'default_template', private.support_default_template(),
    'people', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.name, 'role', pr.role, 'whatsapp', pr.whatsapp,
                 'leads', (select coalesce(jsonb_agg(distinct replace(t.project_role, 'lead_', '')), '[]'::jsonb)
                           from public.project_team t where t.user_id = pr.id and t.active and t.project_role like 'lead\_%'),
                 'projects_led', (select count(distinct t.project_id) from public.project_team t
                                  where t.user_id = pr.id and t.active and t.project_role like 'lead\_%'))
               order by pr.name), '[]'::jsonb)
               from public.profiles pr
               where pr.tenant_id = p_tenant and pr.status = 'ativo' and pr.role in ('leader', 'unit_admin', 'customer_success', 'global_admin')),
    'categories', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'label', c.label, 'description', c.description, 'target', c.target,
                     'active', c.active, 'sort_order', c.sort_order) order by c.sort_order, c.label), '[]'::jsonb) from public.support_categories c),
    'can_edit_categories', private.is_global_admin());
end;
$$;

create or replace function private.support_settings_save(p_tenant uuid, p_cs_whatsapp text, p_template text) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tpl text := nullif(trim(coalesce(p_template, '')), '');
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Somente a administração configura o atendimento' using errcode = '42501'; end if;
  if v_tpl is not null and length(v_tpl) < 10 then raise exception 'Mensagem muito curta' using errcode = '23514'; end if;
  if v_tpl = private.support_default_template() then v_tpl := null; end if;
  insert into public.support_settings (tenant_id, cs_whatsapp, message_template, updated_by, updated_at)
  values (p_tenant, private.normalize_whatsapp(p_cs_whatsapp), v_tpl, private.current_profile_id(), now())
  on conflict (tenant_id) do update set cs_whatsapp = excluded.cs_whatsapp, message_template = excluded.message_template,
    updated_by = excluded.updated_by, updated_at = now();
end;
$$;

create or replace function private.set_person_whatsapp(p_profile uuid, p_whatsapp text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  t public.profiles;
  v text := private.normalize_whatsapp(p_whatsapp);
begin
  select * into t from public.profiles where id = p_profile;
  if t.id is null or t.role = 'client' or not private.can_manage_tenant(t.tenant_id) then
    raise exception 'Pessoa não encontrada ou sem permissão' using errcode = '42501';
  end if;
  update public.profiles set whatsapp = v where id = t.id;
  return v;
end;
$$;

create or replace function private.support_category_save(p_id uuid, p_label text, p_description text, p_target text, p_active boolean) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not private.is_global_admin() then raise exception 'Somente o ADM Global edita os assuntos' using errcode = '42501'; end if;
  if length(trim(coalesce(p_label, ''))) < 2 then raise exception 'Informe o assunto' using errcode = '23514'; end if;
  if p_target not in ('architecture', 'engineering', 'approval', 'cs') then raise exception 'Destino inválido' using errcode = '23514'; end if;
  if p_id is null then
    insert into public.support_categories (label, description, target, sort_order)
    values (trim(p_label), nullif(trim(coalesce(p_description, '')), ''), p_target,
            coalesce((select max(sort_order) from public.support_categories), 0) + 10)
    returning id into v_id;
  else
    update public.support_categories set label = trim(p_label), description = nullif(trim(coalesce(p_description, '')), ''),
      target = p_target, active = coalesce(p_active, active) where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers
-- -----------------------------------------------------------------------------
create or replace function public.support_options() returns jsonb
language sql security invoker set search_path = '' as $$ select private.support_options() $$;
create or replace function public.support_open(p_project uuid, p_category uuid, p_message text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.support_open(p_project, p_category, p_message) $$;
create or replace function public.support_tickets_list() returns jsonb
language sql security invoker set search_path = '' as $$ select private.support_tickets_list() $$;
create or replace function public.support_ticket_update(p_id uuid, p_status text, p_note text) returns void
language sql security invoker set search_path = '' as $$ select private.support_ticket_update(p_id, p_status, p_note) $$;
create or replace function public.support_settings_get(p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.support_settings_get(p_tenant) $$;
create or replace function public.support_settings_save(p_tenant uuid, p_cs_whatsapp text, p_template text) returns void
language sql security invoker set search_path = '' as $$ select private.support_settings_save(p_tenant, p_cs_whatsapp, p_template) $$;
create or replace function public.set_person_whatsapp(p_profile uuid, p_whatsapp text) returns text
language sql security invoker set search_path = '' as $$ select private.set_person_whatsapp(p_profile, p_whatsapp) $$;
create or replace function public.support_category_save(p_id uuid, p_label text, p_description text, p_target text, p_active boolean) returns uuid
language sql security invoker set search_path = '' as $$ select private.support_category_save(p_id, p_label, p_description, p_target, p_active) $$;

revoke all on function private.normalize_whatsapp(text), private.support_default_template(), private.support_contact(uuid, text),
  private.support_options(), private.support_open(uuid, uuid, text), private.url_encode(text), private.support_tickets_list(),
  private.support_ticket_update(uuid, text, text), private.support_settings_get(uuid), private.support_settings_save(uuid, text, text),
  private.set_person_whatsapp(uuid, text), private.support_category_save(uuid, text, text, text, boolean),
  public.support_options(), public.support_open(uuid, uuid, text), public.support_tickets_list(), public.support_ticket_update(uuid, text, text),
  public.support_settings_get(uuid), public.support_settings_save(uuid, text, text), public.set_person_whatsapp(uuid, text),
  public.support_category_save(uuid, text, text, text, boolean)
from public, anon;
grant execute on function private.normalize_whatsapp(text), private.support_default_template(), private.support_contact(uuid, text),
  private.support_options(), private.support_open(uuid, uuid, text), private.url_encode(text), private.support_tickets_list(),
  private.support_ticket_update(uuid, text, text), private.support_settings_get(uuid), private.support_settings_save(uuid, text, text),
  private.set_person_whatsapp(uuid, text), private.support_category_save(uuid, text, text, text, boolean),
  public.support_options(), public.support_open(uuid, uuid, text), public.support_tickets_list(), public.support_ticket_update(uuid, text, text),
  public.support_settings_get(uuid), public.support_settings_save(uuid, text, text), public.set_person_whatsapp(uuid, text),
  public.support_category_save(uuid, text, text, text, boolean)
to authenticated;
