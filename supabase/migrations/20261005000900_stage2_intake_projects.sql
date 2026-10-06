-- =============================================================================
-- Portal de Projetos YouCon — Migration 0009: Etapa 2
-- CRM → webhook → Central de Entrada → validação → cliente → projeto →
-- distribuição → atribuição de equipe.
--
-- Regras:
--   * Idempotência por (source, external_id): webhook repetido nunca duplica.
--   * Payload original imutável; campos mapeados podem ser corrigidos e reprocessados.
--   * Sem franquias ativas: execução automática pela Franqueadora.
--   * Equipe atribuída por função; Líder do Projeto obrigatório.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Utilitários de normalização (dados vindos do CRM)
-- -----------------------------------------------------------------------------
create or replace function private.norm(p text) returns text
language sql immutable set search_path = ''
as $$
  select nullif(regexp_replace(
    translate(lower(trim(coalesce(p, ''))),
              'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
    '\s+', ' ', 'g'), '')
$$;

-- "R$ 12.500,50" → 12500.50 ; "120,5" → 120.5 ; "1200.75" → 1200.75
create or replace function private.parse_decimal(p text) returns numeric
language plpgsql immutable set search_path = ''
as $$
declare s text := regexp_replace(coalesce(p, ''), '[^0-9,.\-]', '', 'g');
begin
  if s = '' then return null; end if;
  if position(',' in s) > 0 then
    s := replace(replace(s, '.', ''), ',', '.');
  elsif s ~ '^\d{1,3}(\.\d{3})+$' then
    s := replace(s, '.', '');           -- "12.500" = doze mil e quinhentos
  end if;
  return s::numeric;
exception when others then
  return null;
end;
$$;

-- "05/10/2026", "2026-10-05", "2026-10-05T13:00:00Z" → date
create or replace function private.parse_date(p text) returns date
language plpgsql immutable set search_path = ''
as $$
declare s text := trim(coalesce(p, ''));
begin
  if s = '' then return null; end if;
  if s ~ '^\d{1,2}/\d{1,2}/\d{4}' then return to_date(substring(s from '^\d{1,2}/\d{1,2}/\d{4}'), 'DD/MM/YYYY'); end if;
  if s ~ '^\d{4}-\d{2}-\d{2}' then return substring(s from 1 for 10)::date; end if;
  return null;
exception when others then
  return null;
end;
$$;

-- Serviços vindos do CRM: array JSON, texto "A, B; C", ou texto de lista '["A","B"]'.
create or replace function private.split_services(p jsonb) returns text[]
language plpgsql immutable set search_path = ''
as $$
declare
  raw text;
begin
  if p is null or p = 'null'::jsonb then return '{}'; end if;
  if jsonb_typeof(p) = 'array' then
    return array(select trim(x) from jsonb_array_elements_text(p) x where trim(x) <> '');
  end if;
  raw := p #>> '{}';
  if raw ~ '^\s*\[.*\]\s*$' then
    begin
      return private.split_services(raw::jsonb);
    exception when others then
      raw := regexp_replace(raw, '[\[\]"]', '', 'g');
    end;
  end if;
  return array(select trim(x) from regexp_split_to_table(raw, '[,;\n]') x where trim(x) <> '');
end;
$$;

-- Resolve nomes/códigos/apelidos de serviços e pacotes do catálogo.
-- Retorna {"resolved":[{service_id, code, name, package_id, input}], "unknown":[...]}
create or replace function private.resolve_services(p_items text[]) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  item text;
  resolved jsonb := '[]'::jsonb;
  unknown jsonb := '[]'::jsonb;
  v_service public.services;
  v_package public.service_packages;
  found boolean;
begin
  foreach item in array coalesce(p_items, '{}') loop
    found := false;
    select * into v_service from public.services s
     where s.active and (private.norm(s.name) = private.norm(item) or private.norm(s.code) = private.norm(item)
            or exists (select 1 from unnest(s.aliases) a where private.norm(a) = private.norm(item)))
     limit 1;
    if v_service.id is not null then
      resolved := resolved || jsonb_build_object('service_id', v_service.id, 'code', v_service.code,
                    'name', v_service.name, 'package_id', null, 'input', item);
      found := true;
    else
      select * into v_package from public.service_packages p
       where p.active and (private.norm(p.name) = private.norm(item) or private.norm(p.code) = private.norm(item)
              or exists (select 1 from unnest(p.aliases) a where private.norm(a) = private.norm(item)))
       limit 1;
      if v_package.id is not null then
        resolved := resolved || coalesce((
          select jsonb_agg(jsonb_build_object('service_id', s.id, 'code', s.code, 'name', s.name,
                                              'package_id', v_package.id, 'input', item))
          from public.package_services ps join public.services s on s.id = ps.service_id
          where ps.package_id = v_package.id and s.active), '[]'::jsonb);
        found := true;
      end if;
    end if;
    if not found then unknown := unknown || to_jsonb(item); end if;
    v_service := null; v_package := null;
  end loop;

  -- remove duplicados mantendo a primeira ocorrência
  resolved := coalesce((select jsonb_agg(r order by ord) from (
                select distinct on (r ->> 'service_id') r, ord
                from jsonb_array_elements(resolved) with ordinality t(r, ord)
                order by r ->> 'service_id', ord) d), '[]'::jsonb);
  return jsonb_build_object('resolved', resolved, 'unknown', unknown);
end;
$$;

-- -----------------------------------------------------------------------------
-- Token de integração (somente o hash fica no banco)
-- -----------------------------------------------------------------------------
create table private.integration_tokens (
  source     text primary key,
  token_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create or replace function public.verify_integration_token(p_source text, p_token text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select t.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    from private.integration_tokens t where t.source = p_source), false)
$$;
revoke all on function public.verify_integration_token(text, text) from public, anon, authenticated;
grant execute on function public.verify_integration_token(text, text) to service_role;

-- -----------------------------------------------------------------------------
-- Avisos
-- -----------------------------------------------------------------------------
create or replace function private.notify(
  p_tenant uuid, p_kind text, p_title text, p_body text, p_entity_type text, p_entity_id uuid,
  p_data jsonb default '{}'::jsonb, p_roles public.user_role[] default null, p_profile uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare r public.user_role;
begin
  if p_profile is not null then
    insert into public.notifications (tenant_id, recipient_profile_id, kind, title, body, entity_type, entity_id, data)
    values (p_tenant, p_profile, p_kind, p_title, p_body, p_entity_type, p_entity_id, coalesce(p_data, '{}'::jsonb));
  end if;
  foreach r in array coalesce(p_roles, '{}') loop
    insert into public.notifications (tenant_id, recipient_role, kind, title, body, entity_type, entity_id, data)
    values (p_tenant, r, p_kind, p_title, p_body, p_entity_type, p_entity_id, coalesce(p_data, '{}'::jsonb));
  end loop;
end;
$$;

-- O usuário só marca leitura; mudanças feitas por funções internas (owner) são permitidas.
create or replace function private.guard_notification_update()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if auth.uid() is null or current_user not in ('authenticated', 'anon') then return new; end if;
  if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
    raise exception 'Somente a leitura do aviso pode ser alterada' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.resolve_notifications(p_kind text, p_entity uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.notifications set resolved_at = now()
  where kind = p_kind and entity_id = p_entity and resolved_at is null;
$$;

create or replace function private.headquarters_id() returns uuid
language sql stable security definer set search_path = ''
as $$ select id from public.tenants where type = 'franqueadora' limit 1 $$;

-- -----------------------------------------------------------------------------
-- Mapeamento do payload → colunas da entrada (aceita o contrato aninhado e chaves planas)
-- -----------------------------------------------------------------------------
create or replace function private.map_intake_payload(p jsonb) returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  c jsonb := coalesce(p -> 'cliente', '{}'::jsonb);
  pr jsonb := coalesce(p -> 'projeto', '{}'::jsonb);
  v_type text := private.norm(coalesce(c ->> 'tipo', p ->> 'cliente_tipo', p ->> 'client_type'));
  v_kind text := private.norm(coalesce(p ->> 'tipo', p ->> 'tipo_contrato', p ->> 'intake_kind'));
  v_state text := upper(trim(coalesce(pr ->> 'uf', p ->> 'uf', p ->> 'estado', '')));
begin
  return jsonb_build_object(
    'client_name',     nullif(trim(coalesce(c ->> 'nome', p ->> 'cliente_nome', p ->> 'client_name', '')), ''),
    'client_email',    nullif(lower(trim(coalesce(c ->> 'email', p ->> 'cliente_email', p ->> 'client_email', ''))), ''),
    'client_phone',    nullif(trim(coalesce(c ->> 'telefone', p ->> 'cliente_telefone', p ->> 'client_phone', '')), ''),
    'client_document', nullif(regexp_replace(coalesce(c ->> 'documento', p ->> 'cliente_documento', p ->> 'cpf_cnpj', ''), '\D', '', 'g'), ''),
    'client_type',     case when v_type in ('b2b','pj','empresa','pessoa juridica') then 'b2b'
                            when v_type in ('b2c','pf','pessoa fisica') then 'b2c' end,
    'company_name',    nullif(trim(coalesce(c ->> 'empresa', p ->> 'empresa', '')), ''),
    'intake_kind',     case when v_kind in ('servico_adicional','servico adicional','aditivo','additional_service')
                            then 'additional_service' else 'new_project' end,
    'target_external_id', nullif(trim(coalesce(p ->> 'projeto_referencia', p ->> 'target_project', '')), ''),
    'project_name',    nullif(trim(coalesce(pr ->> 'nome', p ->> 'projeto_nome', p ->> 'project_name', '')), ''),
    'project_type',    nullif(trim(coalesce(pr ->> 'tipo', p ->> 'projeto_tipo', p ->> 'project_type', '')), ''),
    'city',            nullif(trim(coalesce(pr ->> 'cidade', p ->> 'cidade', p ->> 'city', '')), ''),
    'state',           case when v_state ~ '^[A-Z]{2}$' then v_state end,
    'address',         nullif(trim(coalesce(pr ->> 'endereco', p ->> 'endereco', p ->> 'address', '')), ''),
    'area_m2',         private.parse_decimal(coalesce(pr ->> 'area_m2', p ->> 'area_m2', p ->> 'area')),
    'services',        to_jsonb(private.split_services(coalesce(p -> 'servicos', p -> 'services'))),
    'contract_value',  private.parse_decimal(coalesce(p ->> 'valor_contrato', p ->> 'contract_value')),
    'contracted_at',   private.parse_date(coalesce(p ->> 'data_fechamento', p ->> 'contracted_at')),
    'salesperson',     nullif(trim(coalesce(p ->> 'vendedor', p ->> 'salesperson', '')), ''),
    'notes',           nullif(trim(coalesce(p ->> 'observacoes', p ->> 'notes', '')), ''),
    'origin_slug',     nullif(private.norm(p ->> 'unidade_origem'), ''),
    'commercial_slug', nullif(private.norm(p ->> 'unidade_comercial'), '')
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Processamento de uma entrada
-- -----------------------------------------------------------------------------
create or replace function private.process_intake(p_intake uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  i public.project_intakes;
  v_errors text[] := '{}';
  v_warnings text[] := '{}';
  v_res jsonb;
  v_item jsonb;
  v_hq uuid := private.headquarters_id();
  v_commercial uuid;
  v_delivery uuid;
  v_has_franchises boolean;
  v_target public.projects;
  v_client uuid;
  v_project uuid;
  v_doc text;
  v_status public.project_status;
  v_svc public.services;
  v_added int := 0;
begin
  select * into i from public.project_intakes where id = p_intake for update;
  if i.id is null then raise exception 'Entrada não encontrada' using errcode = 'P0002'; end if;
  if i.status in ('processed', 'ignored') then
    return jsonb_build_object('intake_id', i.id, 'status', i.status, 'project_id', i.created_project_id);
  end if;

  update public.project_intakes set status = 'processing', validation_error = null, validation_details = null where id = i.id;
  v_commercial := coalesce(i.tenant_id, v_hq);

  -- ---------- Validação ----------
  v_res := private.resolve_services(array(select jsonb_array_elements_text(coalesce(i.services, '[]'::jsonb))));
  if jsonb_array_length(coalesce(i.services, '[]'::jsonb)) = 0 then
    v_errors := v_errors || 'Nenhum serviço informado.';
  end if;
  if jsonb_array_length(v_res -> 'unknown') > 0 then
    v_errors := v_errors || ('Serviço não reconhecido no catálogo: ' ||
      (select string_agg(x, ', ') from jsonb_array_elements_text(v_res -> 'unknown') x) || '.');
  end if;

  if i.intake_kind = 'additional_service' then
    select * into v_target from public.projects p
     where p.status <> 'cancelled'
       and (p.code = i.target_external_id or (p.external_id = i.target_external_id and p.external_source = i.source))
     limit 1;
    if i.target_external_id is null then
      v_errors := v_errors || 'Serviço adicional sem projeto de referência (projeto_referencia).';
    elsif v_target.id is null then
      v_errors := v_errors || ('Projeto de referência "' || i.target_external_id || '" não encontrado.');
    end if;
  else
    if i.client_name is null then v_errors := v_errors || 'Nome do cliente não informado.'; end if;
    if i.client_type is null then v_errors := v_errors || 'Tipo do cliente (b2c ou b2b) não informado.'; end if;
  end if;

  -- Disponibilidade B2C/B2B
  if i.client_type is not null or v_target.id is not null then
    for v_item in select * from jsonb_array_elements(v_res -> 'resolved') loop
      select * into v_svc from public.services where id = (v_item ->> 'service_id')::uuid;
      if coalesce(i.client_type, v_target.client_type) = 'b2c' and not v_svc.available_for_b2c then
        v_errors := v_errors || (v_svc.name || ' não está disponível para clientes B2C.');
      elsif coalesce(i.client_type, v_target.client_type) = 'b2b' and not v_svc.available_for_b2b then
        v_errors := v_errors || (v_svc.name || ' não está disponível para clientes B2B.');
      end if;
    end loop;
  end if;

  if array_length(v_errors, 1) > 0 then
    update public.project_intakes
       set status = 'error', validation_error = array_to_string(v_errors, ' '),
           validation_details = jsonb_build_object('errors', to_jsonb(v_errors), 'unknown_services', v_res -> 'unknown'),
           resolved_services = v_res -> 'resolved'
     where id = i.id;
    return jsonb_build_object('intake_id', i.id, 'status', 'error', 'errors', to_jsonb(v_errors));
  end if;

  update public.project_intakes set status = 'validated', resolved_services = v_res -> 'resolved' where id = i.id;

  -- ---------- Serviço adicional ----------
  if i.intake_kind = 'additional_service' then
    for v_item in select * from jsonb_array_elements(v_res -> 'resolved') loop
      if not exists (select 1 from public.project_services ps
                     where ps.project_id = v_target.id and ps.service_id = (v_item ->> 'service_id')::uuid and ps.active) then
        insert into public.project_services (project_id, service_id, package_id, contracted_at, status,
                                             contract_source, contract_reference, intake_id)
        values (v_target.id, (v_item ->> 'service_id')::uuid, (v_item ->> 'package_id')::uuid,
                coalesce(i.contracted_at, current_date), 'pending_review', i.source, i.external_id, i.id);
        v_added := v_added + 1;
      end if;
    end loop;
    if v_target.delivery_tenant_id is not null and v_added > 0 then
      perform private.notify(v_target.delivery_tenant_id, 'service_added', 'Novo serviço aguardando revisão',
        v_target.name, 'projects', v_target.id, jsonb_build_object('intake_id', i.id),
        array['leader','unit_admin']::public.user_role[]);
    end if;
    update public.project_intakes
       set status = 'processed', processed_at = now(), created_project_id = v_target.id,
           created_client_id = v_target.client_id, target_project_id = v_target.id,
           validation_details = case when v_added = 0
             then jsonb_build_object('warnings', jsonb_build_array('Todos os serviços já estavam ativos no projeto.')) end
     where id = i.id;
    perform private.log_audit('intake_processed', 'project_intakes', i.id, v_commercial,
      jsonb_build_object('kind', 'additional_service', 'project_id', v_target.id, 'services_added', v_added));
    return jsonb_build_object('intake_id', i.id, 'status', 'processed', 'project_id', v_target.id, 'services_added', v_added);
  end if;

  -- ---------- Cliente (reaproveita por documento ou e-mail na unidade comercial) ----------
  v_doc := case when length(i.client_document) in (11, 14) then i.client_document end;
  if i.client_document is not null and v_doc is null then
    v_warnings := v_warnings || 'CPF/CNPJ inválido foi ignorado.';
  end if;
  select c.id into v_client from public.clients c
   where c.tenant_id = v_commercial
     and ((v_doc is not null and c.document = v_doc) or (i.client_email is not null and c.email = i.client_email))
   order by (c.document = v_doc) desc nulls last
   limit 1;
  if v_client is null then
    insert into public.clients (tenant_id, name, email, phone, client_type, document, company_name, external_source, external_id)
    values (v_commercial, i.client_name, i.client_email, i.client_phone, i.client_type, v_doc,
            nullif(i.raw_payload #>> '{cliente,empresa}', ''), i.source, null)
    returning id into v_client;
  end if;

  -- ---------- Distribuição ----------
  select exists (select 1 from public.tenants where type = 'franquia' and status = 'ativo') into v_has_franchises;
  if v_has_franchises then
    v_delivery := null; v_status := 'awaiting_allocation';
  else
    v_delivery := v_hq; v_status := 'awaiting_team_assignment';
  end if;

  insert into public.projects (client_id, name, project_type, client_type, origin_tenant_id, commercial_tenant_id,
                               delivery_tenant_id, city, state, address, area_m2, status, contracted_at,
                               external_source, external_id, intake_id)
  values (v_client, coalesce(i.project_name, i.client_name), i.project_type, i.client_type, i.origin_tenant_id,
          v_commercial, v_delivery, i.city, i.state, i.address, i.area_m2, v_status,
          coalesce(i.contracted_at, current_date), i.source, i.external_id, i.id)
  returning id into v_project;

  for v_item in select * from jsonb_array_elements(v_res -> 'resolved') loop
    insert into public.project_services (project_id, service_id, package_id, contracted_at, status,
                                         contract_source, contract_reference, intake_id, activated_at)
    values (v_project, (v_item ->> 'service_id')::uuid, (v_item ->> 'package_id')::uuid,
            coalesce(i.contracted_at, current_date), 'active', i.source, i.external_id, i.id, now());
  end loop;

  if v_has_franchises then
    insert into public.project_allocations (project_id, origin_tenant_id, commercial_tenant_id, delivery_tenant_id,
                                            allocation_method, allocation_status, notes)
    values (v_project, i.origin_tenant_id, v_commercial, null, 'manual', 'pending', 'Aguardando distribuição pela Franqueadora');
    perform private.notify(v_hq, 'project_awaiting_allocation', 'Novo projeto aguardando distribuição',
      coalesce(i.project_name, i.client_name), 'projects', v_project, '{}'::jsonb, array['global_admin']::public.user_role[]);
  else
    insert into public.project_allocations (project_id, origin_tenant_id, commercial_tenant_id, delivery_tenant_id,
                                            allocation_method, allocation_status, allocated_at, notes)
    values (v_project, i.origin_tenant_id, v_commercial, v_hq, 'automatic_headquarters', 'allocated', now(),
            'Sem franquias ativas: execução pela Franqueadora');
    perform private.notify(v_hq, 'project_awaiting_team', 'Novo projeto aguardando equipe',
      coalesce(i.project_name, i.client_name), 'projects', v_project, '{}'::jsonb,
      array['leader','unit_admin']::public.user_role[]);
  end if;

  update public.project_intakes
     set status = 'processed', processed_at = now(), created_client_id = v_client, created_project_id = v_project,
         validation_details = case when array_length(v_warnings, 1) > 0 then jsonb_build_object('warnings', to_jsonb(v_warnings)) end
   where id = i.id;
  perform private.log_audit('intake_processed', 'project_intakes', i.id, v_commercial,
    jsonb_build_object('kind', 'new_project', 'project_id', v_project, 'client_id', v_client));
  return jsonb_build_object('intake_id', i.id, 'status', 'processed', 'project_id', v_project, 'client_id', v_client);

exception when others then
  -- Nada do processamento é mantido; a entrada fica com erro explicado.
  update public.project_intakes
     set status = 'error',
         validation_error = 'Falha ao processar: ' || sqlerrm,
         validation_details = jsonb_build_object('sqlstate', sqlstate)
   where id = p_intake;
  return jsonb_build_object('intake_id', p_intake, 'status', 'error', 'errors', jsonb_build_array(sqlerrm));
end;
$$;

-- -----------------------------------------------------------------------------
-- Ingestão (webhook) — somente service_role (Edge Function após validar o token)
-- -----------------------------------------------------------------------------
create or replace function private.store_intake(p_source text, p_external_id text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  m jsonb := private.map_intake_payload(p_payload);
  v_id uuid;
  v_existing public.project_intakes;
  v_origin uuid;
  v_commercial uuid;
begin
  select id into v_origin from public.tenants where slug = m ->> 'origin_slug';
  select id into v_commercial from public.tenants where slug = m ->> 'commercial_slug';

  insert into public.project_intakes (
    source, external_id, intake_kind, target_external_id, tenant_id, origin_tenant_id,
    client_name, client_email, client_phone, client_document, client_type,
    project_name, project_type, services, contracted_at, contract_value, area_m2,
    city, state, address, salesperson, notes, raw_payload, payload_hash)
  values (
    p_source, p_external_id, (m ->> 'intake_kind')::public.intake_kind, m ->> 'target_external_id',
    coalesce(v_commercial, private.headquarters_id()), v_origin,
    m ->> 'client_name', m ->> 'client_email', m ->> 'client_phone', m ->> 'client_document',
    (m ->> 'client_type')::public.client_type,
    m ->> 'project_name', m ->> 'project_type', coalesce(m -> 'services', '[]'::jsonb),
    (m ->> 'contracted_at')::date, (m ->> 'contract_value')::numeric, (m ->> 'area_m2')::numeric,
    m ->> 'city', m ->> 'state', m ->> 'address', m ->> 'salesperson', m ->> 'notes',
    p_payload, md5(p_payload::text))
  on conflict (source, external_id) do nothing
  returning id into v_id;

  if v_id is null then
    select * into v_existing from public.project_intakes where source = p_source and external_id = p_external_id;
    return jsonb_build_object('intake_id', v_existing.id, 'status', v_existing.status, 'duplicate', true,
                              'project_id', v_existing.created_project_id);
  end if;

  return private.process_intake(v_id) || jsonb_build_object('duplicate', false);
end;
$$;

create or replace function public.ingest_crm_webhook(p_source text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_external text := coalesce(
    nullif(trim(p_payload ->> 'card_id'), ''),
    nullif(trim(p_payload ->> 'id'), ''),
    nullif(trim(p_payload #>> '{data,card,id}'), ''),
    nullif(trim(p_payload #>> '{card,id}'), ''));
begin
  if v_external is null then
    -- Sem identificador não há idempotência: registra para análise, sem processar.
    insert into public.project_intakes (source, external_id, raw_payload, payload_hash, status, validation_error)
    values (p_source, 'sem-id-' || md5(p_payload::text), p_payload, md5(p_payload::text), 'error',
            'Payload sem card_id: não é possível garantir que não haja duplicidade.')
    on conflict (source, external_id) do nothing;
    return jsonb_build_object('status', 'error', 'errors', jsonb_build_array('card_id ausente'));
  end if;
  return private.store_intake(p_source, v_external, p_payload);
end;
$$;
revoke all on function public.ingest_crm_webhook(text, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_crm_webhook(text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- Ações da Central de Entrada (usuários)
-- -----------------------------------------------------------------------------
-- Entrada manual (venda fora do CRM ou contingência).
create or replace function private.create_manual_intake(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := coalesce(nullif(p_payload ->> 'tenant_id', '')::uuid, private.current_tenant_id());
begin
  if not private.can_view_intake(v_tenant) then
    raise exception 'Você não tem permissão para registrar entradas nesta unidade' using errcode = '42501';
  end if;
  return private.store_intake('manual', 'manual-' || gen_random_uuid()::text,
    p_payload || jsonb_build_object('registrado_por', private.current_profile_id(),
                                    'unidade_comercial', (select slug from public.tenants where id = v_tenant)));
end;
$$;

-- Corrige campos mapeados e reprocessa (payload original permanece intacto).
create or replace function private.reprocess_intake(p_intake uuid, p_fields jsonb default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  i public.project_intakes;
  f jsonb := coalesce(p_fields, '{}'::jsonb);
begin
  select * into i from public.project_intakes where id = p_intake;
  if i.id is null or not private.can_view_intake(i.tenant_id) then
    raise exception 'Entrada não encontrada ou sem permissão' using errcode = '42501';
  end if;
  if i.status in ('processed', 'ignored') then
    raise exception 'Esta entrada já foi concluída e não pode ser reprocessada' using errcode = '23514';
  end if;

  update public.project_intakes set
    client_name     = case when f ? 'client_name' then nullif(trim(f ->> 'client_name'), '') else client_name end,
    client_email    = case when f ? 'client_email' then nullif(lower(trim(f ->> 'client_email')), '') else client_email end,
    client_phone    = case when f ? 'client_phone' then nullif(trim(f ->> 'client_phone'), '') else client_phone end,
    client_document = case when f ? 'client_document' then nullif(regexp_replace(f ->> 'client_document', '\D', '', 'g'), '') else client_document end,
    client_type     = case when f ? 'client_type' then nullif(f ->> 'client_type', '')::public.client_type else client_type end,
    intake_kind     = case when f ? 'intake_kind' then (f ->> 'intake_kind')::public.intake_kind else intake_kind end,
    target_external_id = case when f ? 'target_external_id' then nullif(trim(f ->> 'target_external_id'), '') else target_external_id end,
    project_name    = case when f ? 'project_name' then nullif(trim(f ->> 'project_name'), '') else project_name end,
    project_type    = case when f ? 'project_type' then nullif(trim(f ->> 'project_type'), '') else project_type end,
    services        = case when f ? 'services' then to_jsonb(private.split_services(f -> 'services')) else services end,
    contracted_at   = case when f ? 'contracted_at' then private.parse_date(f ->> 'contracted_at') else contracted_at end,
    contract_value  = case when f ? 'contract_value' then private.parse_decimal(f ->> 'contract_value') else contract_value end,
    area_m2         = case when f ? 'area_m2' then private.parse_decimal(f ->> 'area_m2') else area_m2 end,
    city            = case when f ? 'city' then nullif(trim(f ->> 'city'), '') else city end,
    state           = case when f ? 'state' then nullif(upper(trim(f ->> 'state')), '') else state end,
    address         = case when f ? 'address' then nullif(trim(f ->> 'address'), '') else address end,
    notes           = case when f ? 'notes' then nullif(trim(f ->> 'notes'), '') else notes end,
    processed_by    = private.current_profile_id(),
    status          = 'received'
  where id = i.id;

  perform private.log_audit('intake_reprocessed', 'project_intakes', i.id, i.tenant_id, jsonb_build_object('fields', f));
  return private.process_intake(i.id);
end;
$$;

create or replace function private.ignore_intake(p_intake uuid, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
declare i public.project_intakes;
begin
  select * into i from public.project_intakes where id = p_intake;
  if i.id is null or not private.can_view_intake(i.tenant_id) then
    raise exception 'Entrada não encontrada ou sem permissão' using errcode = '42501';
  end if;
  if i.status = 'processed' then
    raise exception 'Entrada já processada não pode ser ignorada' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Informe o motivo para ignorar a entrada' using errcode = '23514';
  end if;
  update public.project_intakes
     set status = 'ignored', processed_at = now(), processed_by = private.current_profile_id(),
         validation_error = 'Ignorada: ' || trim(p_reason)
   where id = i.id;
  perform private.log_audit('intake_ignored', 'project_intakes', i.id, i.tenant_id, jsonb_build_object('reason', p_reason));
end;
$$;

-- -----------------------------------------------------------------------------
-- Distribuição manual (ADM Global)
-- -----------------------------------------------------------------------------
create or replace function private.allocate_project(p_project uuid, p_delivery_tenant uuid, p_notes text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  t public.tenants;
begin
  if not private.can_distribute_projects() then
    raise exception 'Somente a Franqueadora distribui projetos' using errcode = '42501';
  end if;
  select * into p from public.projects where id = p_project for update;
  if p.id is null then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  if p.status not in ('awaiting_allocation', 'awaiting_team_assignment') then
    raise exception 'Projeto com equipe definida não pode mudar de unidade por aqui' using errcode = '23514';
  end if;
  select * into t from public.tenants where id = p_delivery_tenant;
  if t.id is null or t.status <> 'ativo' then
    raise exception 'Unidade executora inválida ou inativa' using errcode = '23514';
  end if;

  update public.project_allocations set allocation_status = 'revoked'
   where project_id = p.id and allocation_status in ('pending', 'allocated', 'offered');
  insert into public.project_allocations (project_id, origin_tenant_id, commercial_tenant_id, delivery_tenant_id,
                                          allocation_method, allocation_status, allocated_by, allocated_at, notes)
  values (p.id, p.origin_tenant_id, p.commercial_tenant_id, t.id, 'manual', 'allocated',
          private.current_profile_id(), now(), nullif(trim(coalesce(p_notes, '')), ''));

  update public.projects set delivery_tenant_id = t.id, status = 'awaiting_team_assignment' where id = p.id;

  perform private.resolve_notifications('project_awaiting_allocation', p.id);
  perform private.resolve_notifications('project_awaiting_team', p.id);
  perform private.notify(t.id, 'project_awaiting_team', 'Novo projeto aguardando equipe', p.name,
    'projects', p.id, '{}'::jsonb, array['leader','unit_admin']::public.user_role[]);
end;
$$;

-- -----------------------------------------------------------------------------
-- Atribuição de equipe por função
-- p_assignments: [{"project_role":"project_lead","user_id":"..."}, ...]
-- -----------------------------------------------------------------------------
create or replace function private.assign_project_team(p_project uuid, p_assignments jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  a jsonb;
  u public.profiles;
  v_role text;
  v_new int := 0;
  v_removed int := 0;
  v_started boolean := false;
begin
  select * into p from public.projects where id = p_project for update;
  if p.id is null or not private.can_assign_team(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para definir a equipe' using errcode = '42501';
  end if;
  if p.status not in ('awaiting_team_assignment', 'in_progress', 'on_hold') then
    raise exception 'A equipe só pode ser definida após a distribuição do projeto' using errcode = '23514';
  end if;
  if jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    raise exception 'Defina ao menos o Líder do Projeto' using errcode = '23514';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_assignments) x where x ->> 'project_role' = 'project_lead') then
    raise exception 'O Líder do Projeto é obrigatório' using errcode = '23514';
  end if;

  -- Validação de cada atribuição
  for a in select * from jsonb_array_elements(p_assignments) loop
    v_role := a ->> 'project_role';
    if not exists (select 1 from public.project_roles r where r.code = v_role and r.active) then
      raise exception 'Função de equipe inválida: %', v_role using errcode = '23514';
    end if;
    select * into u from public.profiles where id = (a ->> 'user_id')::uuid;
    if u.id is null or u.status <> 'ativo' or u.role not in ('collaborator', 'leader', 'unit_admin') then
      raise exception 'Responsável inválido ou inativo para %', v_role using errcode = '23514';
    end if;
    if u.tenant_id is distinct from p.delivery_tenant_id then
      raise exception 'Responsável para % não pertence à unidade executora do projeto', v_role using errcode = '23514';
    end if;
  end loop;

  -- Remove vínculos que saíram
  with incoming as (
    select (x ->> 'user_id')::uuid as user_id, x ->> 'project_role' as project_role
    from jsonb_array_elements(p_assignments) x)
  update public.project_team t
     set active = false, removed_at = now(), removed_by = private.current_profile_id()
   where t.project_id = p.id and t.active
     and not exists (select 1 from incoming i where i.user_id = t.user_id and i.project_role = t.project_role);
  get diagnostics v_removed = row_count;

  -- Cria vínculos novos
  for a in select * from jsonb_array_elements(p_assignments) loop
    if not exists (select 1 from public.project_team t where t.project_id = p.id and t.active
                   and t.user_id = (a ->> 'user_id')::uuid and t.project_role = a ->> 'project_role') then
      select * into u from public.profiles where id = (a ->> 'user_id')::uuid;
      insert into public.project_team (project_id, user_id, project_role, employment_type, assigned_by)
      values (p.id, u.id, a ->> 'project_role', u.employment_type, private.current_profile_id());
      v_new := v_new + 1;
      perform private.notify(p.delivery_tenant_id, 'team_assigned', 'Você foi incluído em um projeto', p.name,
        'projects', p.id, jsonb_build_object('project_role', a ->> 'project_role'), null, u.id);
    end if;
  end loop;

  if p.status = 'awaiting_team_assignment' then
    update public.projects set status = 'in_progress', started_at = now() where id = p.id;
    v_started := true;
  end if;
  perform private.resolve_notifications('project_awaiting_team', p.id);
  perform private.log_audit(case when v_started then 'team_confirmed_project_started' else 'team_changed' end,
    'projects', p.id, p.delivery_tenant_id,
    jsonb_build_object('assignments', p_assignments, 'added', v_new, 'removed', v_removed));

  return jsonb_build_object('project_id', p.id, 'started', v_started, 'added', v_new, 'removed', v_removed);
end;
$$;


-- -----------------------------------------------------------------------------
-- API pública: invólucros SECURITY INVOKER (a lógica privilegiada fica em private,
-- fora da API exposta, e revalida a permissão do usuário logado).
-- -----------------------------------------------------------------------------
create or replace function public.create_manual_intake(p_payload jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.create_manual_intake(p_payload) $$;
create or replace function public.reprocess_intake(p_intake uuid, p_fields jsonb default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.reprocess_intake(p_intake, p_fields) $$;
create or replace function public.ignore_intake(p_intake uuid, p_reason text) returns void
language sql security invoker set search_path = ''
as $$ select private.ignore_intake(p_intake, p_reason) $$;
create or replace function public.allocate_project(p_project uuid, p_delivery_tenant uuid, p_notes text default null) returns void
language sql security invoker set search_path = ''
as $$ select private.allocate_project(p_project, p_delivery_tenant, p_notes) $$;
create or replace function public.assign_project_team(p_project uuid, p_assignments jsonb) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.assign_project_team(p_project, p_assignments) $$;

-- Avisos não resolvidos do usuário (Home / sino).
create or replace function public.my_notifications(p_limit int default 20) returns setof public.notifications
language sql stable security invoker set search_path = ''
as $$
  select * from public.notifications
  where resolved_at is null
  order by created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

-- -----------------------------------------------------------------------------
-- Privilégios
-- -----------------------------------------------------------------------------
revoke all on function public.create_manual_intake(jsonb), public.reprocess_intake(uuid, jsonb),
                       public.ignore_intake(uuid, text), public.allocate_project(uuid, uuid, text),
                       public.assign_project_team(uuid, jsonb), public.my_notifications(int)
  from public, anon;
grant execute on function public.create_manual_intake(jsonb), public.reprocess_intake(uuid, jsonb),
                          public.ignore_intake(uuid, text), public.allocate_project(uuid, uuid, text),
                          public.assign_project_team(uuid, jsonb), public.my_notifications(int)
  to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
-- Funções internas de processamento não são chamáveis por usuários.
revoke execute on function private.process_intake(uuid), private.store_intake(text, text, jsonb),
                           private.notify(uuid, text, text, text, text, uuid, jsonb, public.user_role[], uuid),
                           private.resolve_notifications(text, uuid)
  from authenticated;
revoke execute on function private.link_profile_on_auth_user() from authenticated;
