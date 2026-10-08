-- =============================================================================
-- 0039 · Aprovações de projeto e comissões do setor de aprovação
--
--   * Tipos de aprovação (Prefeitura, Condomínio e os trâmites específicos).
--     Cada trâmite específico vira um serviço da família "Aprovações e
--     Trâmites" com cronograma padrão de uma etapa (análise do órgão), que a
--     liderança inclui no cronograma do projeto quando o cliente precisar.
--   * "Projeto aprovado": quem cuida da aprovação escolhe quais protocolos
--     foram aprovados e anexa o comprovante (imagem ou PDF).
--   * Comissão: valor padrão por tipo e unidade (ADM). Fluxo:
--     Aguardando conferência (líder de aprovação confere o comprovante)
--       → A liberar (ADM) → Liberada → Paga.  Comprovante recusado volta para
--     quem registrou reenviar. Cancelamento só pela administração.
--   * Comissionado: responsável pelo trâmite no projeto (ADM pode trocar).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tipos de aprovação (catálogo da rede)
-- -----------------------------------------------------------------------------
create table public.approval_types (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null check (length(trim(name)) between 2 and 80),
  service_id uuid references public.services (id),
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.approval_types enable row level security;
create policy approval_types_select on public.approval_types for select to authenticated using (private.is_staff());
revoke all on public.approval_types from anon;
grant select on public.approval_types to authenticated;

-- Serviços dos trâmites específicos (Vigilância Sanitária já existia)
insert into public.services (family_id, code, name, description, available_for_b2c, available_for_b2b, has_schedule_template,
                             requires_area_rule, sort_order, aliases, leadership_area)
select f.id, s.code, s.name, s.descr, true, true, true, false, s.ord, s.aliases, 'approval'
from public.service_families f,
  (values
    ('tramite_terraplanagem',         'Aprovação de Terraplanagem',          'Trâmite de aprovação de terraplanagem.',               40, '{"Terraplanagem","Terraplenagem"}'::text[]),
    ('tramite_demolicao',             'Aprovação de Projeto de Demolição',   'Trâmite de aprovação do projeto de demolição.',        50, '{"Demolição","Projeto de Demolição"}'::text[]),
    ('tramite_regularizacao_terreno', 'Regularização de Terreno',            'Trâmite de regularização do terreno.',                 60, '{"Regularização","Regularização de Terreno"}'::text[]),
    ('tramite_supressao_vegetal',     'Supressão Vegetal',                   'Autorização de supressão vegetal.',                    70, '{"Supressão Vegetal","Supressão"}'::text[]),
    ('tramite_cindacta',              'Aprovação CINDACTA',                  'Aprovação junto ao CINDACTA (aeronáutica).',           80, '{"CINDACTA","DECEA"}'::text[]),
    ('tramite_ligacoes',              'Ligação de Água, Energia e Esgoto',   'Pedidos de ligação de água, energia e esgoto.',        90, '{"Ligação de Água","Ligação de Energia","Ligação de Esgoto"}'::text[]),
    ('tramite_pgr',                   'PGR',                                 'Plano de Gerenciamento de Resíduos.',                 100, '{"PGR","Plano de Gerenciamento de Resíduos"}'::text[])
  ) as s(code, name, descr, ord, aliases)
where f.code = 'aprovacoes'
on conflict (code) do nothing;
update public.services set leadership_area = 'approval', has_schedule_template = true where code = 'tramites_vigilancia_sanitaria';

-- Cronograma padrão de uma etapa para cada trâmite (prazo do órgão)
do $tpl$
declare
  s record;
  v_tpl uuid;
begin
  for s in
    select sv.id, sv.code, sv.name from public.services sv
    where sv.code in ('tramite_terraplanagem', 'tramite_demolicao', 'tramite_regularizacao_terreno', 'tramite_supressao_vegetal',
                      'tramite_cindacta', 'tramites_vigilancia_sanitaria', 'tramite_ligacoes', 'tramite_pgr')
      and not exists (select 1 from public.schedule_templates t where t.service_id = sv.id and t.active)
  loop
    insert into public.schedule_templates (service_id, name, version, status, active, notes)
    values (s.id, s.name, coalesce((select max(version) from public.schedule_templates where service_id = s.id), 0) + 1,
            'draft', false, 'Padrão YouCon — trâmite de aprovação (uma etapa)')
    returning id into v_tpl;
    insert into public.template_tasks (template_id, code, name, description, sort_order, default_duration_days, duration_type, client_visible)
    values (v_tpl, 'aprovacao_orgao',
            case s.code when 'tramites_vigilancia_sanitaria' then 'Aprovação na Vigilância Sanitária'
                        when 'tramite_ligacoes' then 'Ligação de Água, Energia e Esgoto'
                        when 'tramite_pgr' then 'Aprovação do PGR'
                        when 'tramite_regularizacao_terreno' then 'Regularização do Terreno'
                        when 'tramite_supressao_vegetal' then 'Autorização de Supressão Vegetal'
                        else s.name end,
            'Protocolo e análise no órgão responsável. Prazo depende do órgão.', 10, null, 'external', true);
    update public.schedule_templates set status = 'published', active = true, published_at = now() where id = v_tpl;
  end loop;
end
$tpl$;

insert into public.approval_types (code, name, service_id, sort_order)
select t.code, t.name, (select id from public.services where code = t.svc), t.ord
from (values
  ('prefeitura',            'Prefeitura',                         'aprovacao_projeto_legal',        10),
  ('condominio',            'Condomínio',                         'aprovacao_projeto_legal',        20),
  ('terraplanagem',         'Terraplanagem',                      'tramite_terraplanagem',          30),
  ('demolicao',             'Projeto de Demolição',               'tramite_demolicao',              40),
  ('regularizacao_terreno', 'Regularização de Terreno',           'tramite_regularizacao_terreno',  50),
  ('supressao_vegetal',     'Supressão Vegetal',                  'tramite_supressao_vegetal',      60),
  ('cindacta',              'CINDACTA',                           'tramite_cindacta',               70),
  ('vigilancia_sanitaria',  'Vigilância Sanitária',               'tramites_vigilancia_sanitaria',  80),
  ('ligacoes',              'Ligação de Água, Energia e Esgoto',  'tramite_ligacoes',               90),
  ('pgr',                   'PGR',                                'tramite_pgr',                   100)
) as t(code, name, svc, ord)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Valor padrão da comissão por tipo e unidade
-- -----------------------------------------------------------------------------
create table public.approval_rates (
  tenant_id        uuid not null references public.tenants (id),
  approval_type_id uuid not null references public.approval_types (id),
  amount           numeric(12,2) not null check (amount >= 0),
  updated_by       uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, approval_type_id)
);
alter table public.approval_rates enable row level security;
revoke all on public.approval_rates from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Aprovações registradas (uma por tipo e projeto) com a comissão
-- -----------------------------------------------------------------------------
create table public.project_approvals (
  id                 uuid primary key,
  project_id         uuid not null references public.projects (id),
  tenant_id          uuid not null references public.tenants (id),
  approval_type_id   uuid not null references public.approval_types (id),
  project_service_id uuid references public.project_services (id),
  task_id            uuid references public.project_tasks (id),
  protocol_number    text check (protocol_number is null or length(protocol_number) <= 80),
  approved_on        date not null,
  proof              jsonb not null,
  notes              text check (notes is null or length(notes) <= 1000),
  registered_by      uuid references public.profiles (id),
  registered_at      timestamptz not null default now(),
  recipient_id       uuid references public.profiles (id),
  amount             numeric(12,2) check (amount is null or amount >= 0),
  status             text not null default 'awaiting_review'
                     check (status in ('awaiting_review', 'proof_rejected', 'to_release', 'released', 'paid', 'cancelled')),
  review_note        text check (review_note is null or length(review_note) <= 500),
  reviewed_by        uuid references public.profiles (id),
  reviewed_at        timestamptz,
  released_by        uuid references public.profiles (id),
  released_at        timestamptz,
  paid_by            uuid references public.profiles (id),
  paid_at            timestamptz,
  cancel_note        text check (cancel_note is null or length(cancel_note) <= 500),
  updated_at         timestamptz not null default now()
);
create unique index project_approvals_one_per_type on public.project_approvals (project_id, approval_type_id) where status <> 'cancelled';
create index project_approvals_tenant_idx on public.project_approvals (tenant_id, status);
create trigger project_approvals_touch before update on public.project_approvals for each row execute function private.touch_updated_at();
alter table public.project_approvals enable row level security;
revoke all on public.project_approvals from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Permissões
-- -----------------------------------------------------------------------------
create or replace function private.is_approval_lead(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.project_team t
                 where t.project_id = p_project and t.active and t.project_role = 'lead_approval'
                   and t.user_id = private.current_profile_id())
$$;

-- Responsável por algum serviço ou etapa da área de aprovação no projeto.
create or replace function private.is_approval_worker(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.project_services ps join public.services s on s.id = ps.service_id
    where ps.project_id = p_project and ps.active and s.leadership_area = 'approval'
      and (ps.responsible_user_id = private.current_profile_id()
           or exists (select 1 from public.project_schedule_tracks tr join public.project_tasks t on t.schedule_track_id = tr.id
                      where tr.project_service_id = ps.id and t.responsible_user_id = private.current_profile_id())))
$$;

create or replace function private.can_register_approval(p_project uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_staff() and (private.can_manage_project(p_project) or private.is_approval_lead(p_project)
                                 or private.is_approval_worker(p_project))
$$;

-- Administração das comissões: ADM da unidade executora ou ADM Global.
create or replace function private.can_admin_approvals(p_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin() or (private.my_role() = 'unit_admin' and p_tenant = private.current_tenant_id())
$$;

create or replace function private.can_review_approval(p_project uuid, p_tenant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_approval_lead(p_project) or private.can_admin_approvals(p_tenant) $$;

-- Aba "Aprovações": ADMs e quem é líder de aprovação em algum projeto.
create or replace function private.can_view_approvals() returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_global_admin() or private.my_role() = 'unit_admin'
      or exists (select 1 from public.project_team t
                 where t.active and t.project_role = 'lead_approval' and t.user_id = private.current_profile_id())
$$;

revoke all on function private.is_approval_lead(uuid), private.is_approval_worker(uuid), private.can_register_approval(uuid),
  private.can_admin_approvals(uuid), private.can_review_approval(uuid, uuid), private.can_view_approvals() from public, anon;
grant execute on function private.is_approval_lead(uuid), private.is_approval_worker(uuid), private.can_register_approval(uuid),
  private.can_admin_approvals(uuid), private.can_review_approval(uuid, uuid), private.can_view_approvals() to authenticated;

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
create or replace function private.approval_json(a public.project_approvals, p_financial boolean) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'project_id', a.project_id, 'tenant_id', a.tenant_id,
    'project_name', p.name, 'project_code', p.code, 'client_name', c.name, 'tenant_name', tn.name,
    'type_id', a.approval_type_id, 'type_name', ty.name, 'type_code', ty.code,
    'protocol_number', a.protocol_number, 'approved_on', a.approved_on, 'proof', a.proof, 'notes', a.notes,
    'status', a.status, 'review_note', a.review_note, 'cancel_note', a.cancel_note,
    'registered_at', a.registered_at, 'reviewed_at', a.reviewed_at, 'released_at', a.released_at, 'paid_at', a.paid_at,
    'registered_by', case when rb.id is not null then jsonb_build_object('id', rb.id, 'name', rb.name) end,
    'reviewed_by', case when rv.id is not null then jsonb_build_object('id', rv.id, 'name', rv.name) end,
    'recipient', case when rc.id is not null then jsonb_build_object('id', rc.id, 'name', rc.name, 'avatar_url', rc.avatar_url,
                                                                   'employment_type', rc.employment_type) end,
    'amount', case when p_financial then a.amount end,
    'can_resubmit', a.status = 'proof_rejected' and private.can_register_approval(a.project_id),
    'can_review', a.status = 'awaiting_review' and private.can_review_approval(a.project_id, a.tenant_id),
    'can_admin', private.can_admin_approvals(a.tenant_id)
  )
  from public.projects p
  join public.approval_types ty on ty.id = a.approval_type_id
  left join public.clients c on c.id = p.client_id
  left join public.tenants tn on tn.id = a.tenant_id
  left join public.profiles rb on rb.id = a.registered_by
  left join public.profiles rv on rv.id = a.reviewed_by
  left join public.profiles rc on rc.id = a.recipient_id
  where p.id = a.project_id
$$;

-- Quem recebe por padrão: responsável pela etapa do trâmite → responsável pelo
-- serviço → líder de aprovação do projeto.
create or replace function private.approval_default_recipient(p_project uuid, p_service uuid, p_task uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select responsible_user_id from public.project_tasks where id = p_task),
    (select responsible_user_id from public.project_services where id = p_service),
    (select t.user_id from public.project_team t where t.project_id = p_project and t.active and t.project_role = 'lead_approval'
      order by t.assigned_at limit 1))
$$;

-- Protocolos do projeto: tipos ligados aos serviços contratados (abertos) e o
-- que já foi registrado. Usado no card do projeto e no "Projeto aprovado".
create or replace function private.project_approval_board(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  v_fin boolean;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.is_staff() or not private.can_view_project(p.id) then
    raise exception 'Projeto não encontrado' using errcode = 'P0002';
  end if;
  v_fin := private.can_review_approval(p.id, p.delivery_tenant_id);
  return jsonb_build_object(
    'can_register', private.can_register_approval(p.id),
    'can_include', private.can_edit_schedule(p.id) and p.status in ('in_progress', 'on_hold'),
    'protocols', (
      select coalesce(jsonb_agg(x order by (x ->> 'sort_order')::int), '[]'::jsonb) from (
        select jsonb_build_object(
          'type_id', ty.id, 'type_code', ty.code, 'type_name', ty.name, 'sort_order', ty.sort_order,
          'project_service_id', ps.id, 'service_name', s.name,
          'task_id', tk.id, 'task_status', tk.status,
          'approval_id', a.id, 'approval_status', a.status,
          'recipient_id', private.approval_default_recipient(p.id, ps.id, tk.id)
        ) as x
        from public.approval_types ty
        join public.project_services ps on ps.service_id = ty.service_id and ps.project_id = p.id and ps.active and ps.status in ('active', 'completed')
        join public.services s on s.id = ps.service_id
        left join lateral (
          select t.id, t.status from public.project_schedule_tracks tr join public.project_tasks t on t.schedule_track_id = tr.id
          where tr.project_service_id = ps.id and s.code <> 'aprovacao_projeto_legal'
          order by t.sequence desc limit 1) tk on true
        left join public.project_approvals a on a.project_id = p.id and a.approval_type_id = ty.id and a.status <> 'cancelled'
        where ty.active
      ) q),
    'approvals', (
      select coalesce(jsonb_agg(private.approval_json(a, v_fin) order by a.approved_on desc, a.registered_at desc), '[]'::jsonb)
      from public.project_approvals a where a.project_id = p.id and a.status <> 'cancelled'),
    'tramites', (
      select coalesce(jsonb_agg(jsonb_build_object('service_id', s.id, 'name', s.name,
               'included', exists (select 1 from public.project_services x where x.project_id = p.id and x.service_id = s.id and x.active))
             order by s.sort_order), '[]'::jsonb)
      from public.services s join public.service_families f on f.id = s.family_id
      where f.code = 'aprovacoes' and s.active and s.code <> 'aprovacao_projeto_legal'
        and exists (select 1 from public.schedule_templates t where t.service_id = s.id and t.active))
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Registrar "Projeto aprovado" (ou reenviar comprovante recusado)
-- p_proof: {path, name, size, type} já enviado para approval-proofs/{projeto}/{id}/...
-- -----------------------------------------------------------------------------
create or replace function private.approval_register(p_id uuid, p_project uuid, p_type uuid, p_approved_on date,
                                                     p_protocol text, p_proof jsonb, p_notes text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  ty public.approval_types;
  a public.project_approvals;
  v_ps uuid;
  v_task uuid;
  v_exists boolean;
  v_lead record;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_register_approval(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para registrar a aprovação' using errcode = '42501';
  end if;
  select * into ty from public.approval_types where id = p_type and active;
  if ty.id is null then raise exception 'Tipo de aprovação inválido' using errcode = '23514'; end if;
  if p_approved_on is null or p_approved_on > private.today_br() then
    raise exception 'Informe a data da aprovação (não pode ser futura)' using errcode = '23514';
  end if;
  if p_id is null then raise exception 'Identificador inválido' using errcode = '22023'; end if;

  -- Comprovante obrigatório: imagem ou PDF dentro da pasta desta aprovação.
  if p_proof is null or jsonb_typeof(p_proof) <> 'object'
     or coalesce(p_proof ->> 'path', '') not like p.id::text || '/' || p_id::text || '/%' or (p_proof ->> 'path') ~ '\.\.' then
    raise exception 'Anexe o comprovante da aprovação' using errcode = '23514';
  end if;
  if coalesce(p_proof ->> 'type', '') not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    raise exception 'O comprovante deve ser PDF ou imagem (JPG, PNG ou WebP)' using errcode = '23514';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
      into v_exists using 'approval-proofs', p_proof ->> 'path';
    if not v_exists then raise exception 'Comprovante não encontrado no armazenamento. Envie novamente.' using errcode = '23514'; end if;
  end if;

  select * into a from public.project_approvals where id = p_id for update;
  if a.id is not null then
    -- Reenvio de comprovante recusado
    if a.project_id <> p.id or a.approval_type_id <> ty.id then raise exception 'Aprovação inválida' using errcode = '23514'; end if;
    if a.status <> 'proof_rejected' then
      raise exception 'Esta aprovação já foi registrada' using errcode = '23514';
    end if;
    update public.project_approvals set
      approved_on = p_approved_on, protocol_number = nullif(trim(p_protocol), ''), notes = nullif(trim(p_notes), ''),
      proof = jsonb_build_object('path', p_proof ->> 'path', 'name', left(coalesce(nullif(p_proof ->> 'name', ''), 'comprovante'), 120),
                                 'size', coalesce((p_proof ->> 'size')::bigint, 0), 'type', p_proof ->> 'type'),
      status = 'awaiting_review', registered_by = private.current_profile_id(), registered_at = now()
    where id = a.id;
  else
    if exists (select 1 from public.project_approvals x where x.project_id = p.id and x.approval_type_id = ty.id and x.status <> 'cancelled') then
      raise exception 'A aprovação de % já foi registrada neste projeto', ty.name using errcode = '23514';
    end if;
    select ps.id into v_ps from public.project_services ps
     where ps.project_id = p.id and ps.service_id = ty.service_id and ps.active limit 1;
    select t.id into v_task from public.project_schedule_tracks tr join public.project_tasks t on t.schedule_track_id = tr.id
     join public.project_services ps on ps.id = tr.project_service_id join public.services s on s.id = ps.service_id
     where tr.project_service_id = v_ps and s.code <> 'aprovacao_projeto_legal'
     order by t.sequence desc limit 1;

    insert into public.project_approvals (id, project_id, tenant_id, approval_type_id, project_service_id, task_id,
      protocol_number, approved_on, proof, notes, registered_by, recipient_id, amount)
    values (p_id, p.id, p.delivery_tenant_id, ty.id, v_ps, v_task, nullif(trim(p_protocol), ''), p_approved_on,
      jsonb_build_object('path', p_proof ->> 'path', 'name', left(coalesce(nullif(p_proof ->> 'name', ''), 'comprovante'), 120),
                         'size', coalesce((p_proof ->> 'size')::bigint, 0), 'type', p_proof ->> 'type'),
      nullif(trim(p_notes), ''), private.current_profile_id(),
      coalesce(private.approval_default_recipient(p.id, v_ps, v_task), private.current_profile_id()),
      (select r.amount from public.approval_rates r where r.tenant_id = p.delivery_tenant_id and r.approval_type_id = ty.id));

    -- A etapa do trâmite no cronograma é concluída (o cliente acompanha).
    if v_task is not null then
      begin
        if (select status from public.project_tasks where id = v_task) not in ('completed', 'cancelled') then
          perform private.set_task_status(v_task, 'completed', 'Aprovado: ' || ty.name);
        end if;
      exception when others then null; -- sem permissão de editar a etapa: só registra a aprovação
      end;
    end if;
  end if;

  perform private.log_audit('approval_registered', 'project_approvals', p_id, p.delivery_tenant_id,
    jsonb_build_object('project_id', p.id, 'type', ty.code));
  for v_lead in
    select distinct t.user_id from public.project_team t
    where t.project_id = p.id and t.active and t.project_role = 'lead_approval' and t.user_id <> private.current_profile_id()
  loop
    perform private.notify(p.delivery_tenant_id, 'approval_review', 'Aprovação para conferir',
      ty.name || ' · ' || p.name, 'project_approvals', p_id, jsonb_build_object('project_id', p.id), null, v_lead.user_id);
  end loop;
  return p_id;
end;
$$;

-- Líder de aprovação (ou ADM) confere o comprovante.
create or replace function private.approval_review(p_id uuid, p_ok boolean, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  a public.project_approvals;
  v_name text;
begin
  select * into a from public.project_approvals where id = p_id for update;
  if a.id is null or not private.can_review_approval(a.project_id, a.tenant_id) then
    raise exception 'Aprovação não encontrada ou sem permissão para conferir' using errcode = '42501';
  end if;
  if a.status <> 'awaiting_review' then raise exception 'Esta aprovação não está aguardando conferência' using errcode = '23514'; end if;
  if not coalesce(p_ok, false) and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Explique o que está errado no comprovante' using errcode = '23514';
  end if;
  select ty.name || ' · ' || p.name into v_name from public.approval_types ty, public.projects p
   where ty.id = a.approval_type_id and p.id = a.project_id;
  update public.project_approvals set
    status = case when p_ok then 'to_release' else 'proof_rejected' end,
    review_note = nullif(trim(p_note), ''), reviewed_by = private.current_profile_id(), reviewed_at = now()
  where id = a.id;
  if p_ok then
    perform private.notify(a.tenant_id, 'approval_release', 'Comissão a liberar', v_name, 'project_approvals', a.id,
      jsonb_build_object('project_id', a.project_id), array['unit_admin']::public.user_role[], null);
  elsif a.registered_by is not null then
    perform private.notify(a.tenant_id, 'approval_rejected', 'Comprovante recusado: reenvie', v_name || ' · ' || trim(p_note),
      'project_approvals', a.id, jsonb_build_object('project_id', a.project_id), null, a.registered_by);
  end if;
end;
$$;

-- ADM: liberar, marcar como paga, voltar um passo ou cancelar.
create or replace function private.approval_set_status(p_id uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare a public.project_approvals;
begin
  select * into a from public.project_approvals where id = p_id for update;
  if a.id is null or not private.can_admin_approvals(a.tenant_id) then
    raise exception 'Somente a administração libera comissões' using errcode = '42501';
  end if;
  if not ((a.status = 'to_release' and p_status = 'released') or (a.status = 'released' and p_status = 'paid')
       or (a.status = 'paid' and p_status = 'released') or (a.status = 'released' and p_status = 'to_release')
       or (a.status <> 'paid' and a.status <> 'cancelled' and p_status = 'cancelled')) then
    raise exception 'Mudança de situação não permitida' using errcode = '23514';
  end if;
  if p_status = 'released' and a.amount is null then
    raise exception 'Defina o valor da comissão antes de liberar' using errcode = '23514';
  end if;
  if p_status = 'cancelled' and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Informe o motivo do cancelamento' using errcode = '23514';
  end if;
  update public.project_approvals set
    status = p_status,
    released_by = case when p_status = 'released' and a.status = 'to_release' then private.current_profile_id()
                       when p_status = 'to_release' then null else released_by end,
    released_at = case when p_status = 'released' and a.status = 'to_release' then now()
                       when p_status = 'to_release' then null else released_at end,
    paid_by = case when p_status = 'paid' then private.current_profile_id() when a.status = 'paid' then null else paid_by end,
    paid_at = case when p_status = 'paid' then now() when a.status = 'paid' then null else paid_at end,
    cancel_note = case when p_status = 'cancelled' then trim(p_note) else cancel_note end
  where id = a.id;
  perform private.log_audit('approval_' || p_status, 'project_approvals', a.id, a.tenant_id, jsonb_build_object('from', a.status));
end;
$$;

-- ADM: ajustar valor e comissionado (antes de paga).
create or replace function private.approval_update(p_id uuid, p_amount numeric, p_recipient uuid) returns void
language plpgsql security definer set search_path = ''
as $$
declare a public.project_approvals;
begin
  select * into a from public.project_approvals where id = p_id for update;
  if a.id is null or not private.can_admin_approvals(a.tenant_id) then
    raise exception 'Somente a administração altera a comissão' using errcode = '42501';
  end if;
  if a.status in ('paid', 'cancelled') then raise exception 'Comissão paga ou cancelada não pode ser alterada' using errcode = '23514'; end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Valor inválido' using errcode = '23514'; end if;
  if p_recipient is not null and not exists (select 1 from public.profiles x where x.id = p_recipient and x.role <> 'client'
                                              and (x.tenant_id = a.tenant_id or private.is_global_admin())) then
    raise exception 'Comissionado inválido' using errcode = '23514';
  end if;
  update public.project_approvals set amount = p_amount, recipient_id = coalesce(p_recipient, recipient_id) where id = a.id;
end;
$$;

-- Lista da aba "Aprovações"
create or replace function private.approvals_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_view_approvals() then
    raise exception 'Sem acesso ao controle de aprovações' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(private.approval_json(a, true) order by a.approved_on desc, a.registered_at desc), '[]'::jsonb)
    from public.project_approvals a
    where a.status <> 'cancelled'
      and (p_tenant is null or a.tenant_id = p_tenant)
      and (private.can_admin_approvals(a.tenant_id) or private.is_approval_lead(a.project_id)));
end;
$$;

-- Valores padrão (ADM vê e edita; líder de aprovação só vê)
create or replace function private.approval_rates_list(p_tenant uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.can_admin_approvals(p_tenant) or (private.can_view_approvals() and p_tenant = private.current_tenant_id())) then
    raise exception 'Sem acesso aos valores de comissão' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('type_id', ty.id, 'code', ty.code, 'name', ty.name, 'active', ty.active,
             'amount', r.amount, 'updated_at', r.updated_at) order by ty.sort_order), '[]'::jsonb)
    from public.approval_types ty
    left join public.approval_rates r on r.approval_type_id = ty.id and r.tenant_id = p_tenant
    where ty.active);
end;
$$;

create or replace function private.approval_rate_save(p_tenant uuid, p_type uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_admin_approvals(p_tenant) then
    raise exception 'Somente a administração define os valores' using errcode = '42501';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 9999999 then raise exception 'Valor inválido' using errcode = '23514'; end if;
  if not exists (select 1 from public.approval_types where id = p_type) then raise exception 'Tipo inválido' using errcode = '23514'; end if;
  insert into public.approval_rates (tenant_id, approval_type_id, amount, updated_by, updated_at)
  values (p_tenant, p_type, round(p_amount, 2), private.current_profile_id(), now())
  on conflict (tenant_id, approval_type_id) do update set amount = excluded.amount, updated_by = excluded.updated_by, updated_at = now();
end;
$$;

-- Incluir um trâmite no cronograma do projeto (gera a trilha a partir do padrão).
create or replace function private.approval_include_tramite(p_project uuid, p_service uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  s public.services;
  v_lead uuid;
begin
  select * into p from public.projects where id = p_project for update;
  if p.id is null or not private.can_edit_schedule(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para alterar o cronograma' using errcode = '42501';
  end if;
  if p.status not in ('in_progress', 'on_hold') then
    raise exception 'Inclua trâmites depois que o cronograma do projeto for gerado' using errcode = '23514';
  end if;
  select sv.* into s from public.services sv join public.service_families f on f.id = sv.family_id
   where sv.id = p_service and sv.active and f.code = 'aprovacoes';
  if s.id is null then raise exception 'Trâmite inválido' using errcode = '23514'; end if;
  if exists (select 1 from public.project_services x where x.project_id = p.id and x.service_id = s.id and x.active) then
    raise exception '% já está no cronograma deste projeto', s.name using errcode = '23514';
  end if;
  select t.user_id into v_lead from public.project_team t
   where t.project_id = p.id and t.active and t.project_role = 'lead_approval' order by t.assigned_at limit 1;
  insert into public.project_services (project_id, service_id, contracted_at, status, contract_source, added_by, activated_at, responsible_user_id)
  values (p.id, s.id, private.today_br(), 'active', 'manual', private.current_profile_id(), now(), v_lead);
  perform private.log_audit('project_service_activated', 'project_services', null, p.delivery_tenant_id,
    jsonb_build_object('project_id', p.id, 'service_id', s.id, 'source', 'tramite'));
  return private.generate_schedule(p.id, 'Trâmite incluído: ' || s.name);
end;
$$;

-- -----------------------------------------------------------------------------
-- Wrappers públicos
-- -----------------------------------------------------------------------------
create or replace function public.project_approval_board(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.project_approval_board(p_project) $$;
create or replace function public.approval_register(p_id uuid, p_project uuid, p_type uuid, p_approved_on date, p_protocol text, p_proof jsonb, p_notes text) returns uuid
language sql security invoker set search_path = '' as $$ select private.approval_register(p_id, p_project, p_type, p_approved_on, p_protocol, p_proof, p_notes) $$;
create or replace function public.approval_review(p_id uuid, p_ok boolean, p_note text) returns void
language sql security invoker set search_path = '' as $$ select private.approval_review(p_id, p_ok, p_note) $$;
create or replace function public.approval_set_status(p_id uuid, p_status text, p_note text) returns void
language sql security invoker set search_path = '' as $$ select private.approval_set_status(p_id, p_status, p_note) $$;
create or replace function public.approval_update(p_id uuid, p_amount numeric, p_recipient uuid) returns void
language sql security invoker set search_path = '' as $$ select private.approval_update(p_id, p_amount, p_recipient) $$;
create or replace function public.approvals_list(p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.approvals_list(p_tenant) $$;
create or replace function public.approval_rates_list(p_tenant uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.approval_rates_list(p_tenant) $$;
create or replace function public.approval_rate_save(p_tenant uuid, p_type uuid, p_amount numeric) returns void
language sql security invoker set search_path = '' as $$ select private.approval_rate_save(p_tenant, p_type, p_amount) $$;
create or replace function public.approval_include_tramite(p_project uuid, p_service uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.approval_include_tramite(p_project, p_service) $$;

revoke all on function
  private.approval_json(public.project_approvals, boolean), private.approval_default_recipient(uuid, uuid, uuid),
  private.project_approval_board(uuid), private.approval_register(uuid, uuid, uuid, date, text, jsonb, text),
  private.approval_review(uuid, boolean, text), private.approval_set_status(uuid, text, text), private.approval_update(uuid, numeric, uuid),
  private.approvals_list(uuid), private.approval_rates_list(uuid), private.approval_rate_save(uuid, uuid, numeric),
  private.approval_include_tramite(uuid, uuid),
  public.project_approval_board(uuid), public.approval_register(uuid, uuid, uuid, date, text, jsonb, text),
  public.approval_review(uuid, boolean, text), public.approval_set_status(uuid, text, text), public.approval_update(uuid, numeric, uuid),
  public.approvals_list(uuid), public.approval_rates_list(uuid), public.approval_rate_save(uuid, uuid, numeric),
  public.approval_include_tramite(uuid, uuid)
from public, anon;
grant execute on function
  private.approval_json(public.project_approvals, boolean), private.approval_default_recipient(uuid, uuid, uuid),
  private.project_approval_board(uuid), private.approval_register(uuid, uuid, uuid, date, text, jsonb, text),
  private.approval_review(uuid, boolean, text), private.approval_set_status(uuid, text, text), private.approval_update(uuid, numeric, uuid),
  private.approvals_list(uuid), private.approval_rates_list(uuid), private.approval_rate_save(uuid, uuid, numeric),
  private.approval_include_tramite(uuid, uuid),
  public.project_approval_board(uuid), public.approval_register(uuid, uuid, uuid, date, text, jsonb, text),
  public.approval_review(uuid, boolean, text), public.approval_set_status(uuid, text, text), public.approval_update(uuid, numeric, uuid),
  public.approvals_list(uuid), public.approval_rates_list(uuid), public.approval_rate_save(uuid, uuid, numeric),
  public.approval_include_tramite(uuid, uuid)
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
    'can_view_performance',  private.can_view_performance(me.id),
    'can_view_approvals',    private.can_view_approvals(),
    'can_admin_approvals',   private.can_admin_approvals(me.tenant_id),
    'is_manager',            private.is_manager(),
    'is_staff',              private.is_staff()
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Comprovantes: bucket privado approval-proofs/{projeto}/{aprovação}/{arquivo}
-- -----------------------------------------------------------------------------
create or replace function private.approval_file_readable(p_project text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return private.is_staff() and private.can_view_project(p_project::uuid);
exception when others then return false;
end;
$$;

create or replace function private.approval_file_writable(p_project text, p_approval text) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  return private.can_register_approval(p_project::uuid)
     and not exists (select 1 from public.project_approvals a
                     where a.id = p_approval::uuid and (a.project_id <> p_project::uuid or a.status <> 'proof_rejected'));
exception when others then return false;
end;
$$;
revoke all on function private.approval_file_readable(text), private.approval_file_writable(text, text) from public, anon;
grant execute on function private.approval_file_readable(text), private.approval_file_writable(text, text) to authenticated;

do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('approval-proofs', 'approval-proofs', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = false, file_size_limit = 10485760,
      allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

    execute $p$create policy approval_proofs_select on storage.objects for select to authenticated
      using (bucket_id = 'approval-proofs' and private.approval_file_readable((storage.foldername(name))[1]))$p$;
    execute $p$create policy approval_proofs_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'approval-proofs'
                  and private.approval_file_writable((storage.foldername(name))[1], (storage.foldername(name))[2]))$p$;
  end if;
end
$do$;
