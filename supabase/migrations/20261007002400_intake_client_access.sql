-- =============================================================================
-- 0024 · Venda vincula o acesso do cliente pelo e-mail
--
-- Problema: a venda manual com um CPF que já existia em outro cliente foi
-- anexada a esse outro cliente (o CPF tinha prioridade sobre o e-mail), e o
-- usuário cliente com o e-mail da venda não via o projeto.
--
--   * process_intake: o cliente é encontrado pelo e-mail (do cliente ou de um
--     contato). Se CPF/CNPJ e e-mail apontarem para clientes diferentes, ou o
--     CPF já pertencer a um cliente com outro e-mail, a entrada fica com erro
--     explicado para revisão (nada é criado).
--   * link_client_access: garante um contato com o e-mail da venda no cliente e,
--     se já existir usuário cliente com esse e-mail, vincula o acesso.
--   * Ao convidar um usuário cliente, ele também é vinculado a todos os clientes
--     da unidade que tenham o mesmo e-mail (trigger em profiles).
-- =============================================================================

create or replace function private.link_client_access(p_client uuid, p_email text, p_name text, p_phone text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := nullif(lower(trim(p_email)), '');
  v_profile uuid;
begin
  if p_client is null or v_email is null then return; end if;
  select pr.id into v_profile from public.profiles pr
   where lower(pr.email) = v_email and pr.role = 'client' and pr.status <> 'inativo'
   limit 1;

  if v_profile is not null and exists (select 1 from public.client_contacts cc where cc.client_id = p_client and cc.profile_id = v_profile) then
    -- Acesso já vinculado neste cliente: só garante que está ativo.
    update public.client_contacts cc set active = true
     where cc.client_id = p_client and cc.profile_id = v_profile and not cc.active;
  elsif exists (select 1 from public.client_contacts cc where cc.client_id = p_client and lower(cc.email) = v_email) then
    update public.client_contacts cc
       set profile_id = coalesce(cc.profile_id, v_profile), active = true
     where cc.id = (select x.id from public.client_contacts x
                     where x.client_id = p_client and lower(x.email) = v_email
                     order by (x.profile_id is null) asc, x.created_at limit 1);
  else
    insert into public.client_contacts (client_id, profile_id, name, email, phone, is_primary)
    values (p_client, v_profile, coalesce(nullif(trim(p_name), ''), v_email), v_email, nullif(trim(p_phone), ''),
            not exists (select 1 from public.client_contacts where client_id = p_client and is_primary and active));
  end if;
end;
$$;
revoke all on function private.link_client_access(uuid, text, text, text) from public, anon, authenticated;

-- Usuário cliente novo: vincula aos clientes (da mesma unidade) com o mesmo e-mail.
-- (um contato por cliente; o que já tiver o usuário não é duplicado)
create or replace function private.profile_link_client_contacts()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.role = 'client' and new.email is not null then
    update public.client_contacts cc set profile_id = new.id
     where cc.profile_id is null and lower(cc.email) = lower(new.email)
       and exists (select 1 from public.clients c where c.id = cc.client_id and c.tenant_id = new.tenant_id)
       and not exists (select 1 from public.client_contacts x where x.client_id = cc.client_id and x.profile_id = new.id);
    insert into public.client_contacts (client_id, profile_id, name, email, is_primary)
    select c.id, new.id, new.name, lower(new.email), false
      from public.clients c
     where c.tenant_id = new.tenant_id and lower(c.email) = lower(new.email)
       and not exists (select 1 from public.client_contacts cc where cc.client_id = c.id and cc.profile_id = new.id);
  end if;
  return new;
end;
$$;
-- Adiado para o fim da transação: roda depois do vínculo explícito feito no convite.
create constraint trigger profiles_link_client_contacts after insert on public.profiles
  deferrable initially deferred
  for each row execute function private.profile_link_client_contacts();

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
  v_by_doc uuid;
  v_by_email uuid;
  v_email text;
  v_doc_name text;
  v_email_name text;
  v_doc_email text;
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

  -- Cliente: CPF/CNPJ e e-mail não podem apontar para clientes diferentes.
  -- O e-mail é o acesso do cliente ao portal; juntar a venda no cliente errado
  -- esconderia o projeto de quem deveria vê-lo. Na dúvida, a entrada fica para revisão.
  if i.intake_kind = 'new_project' then
    v_commercial := coalesce(i.tenant_id, v_hq);
    v_email := nullif(lower(trim(i.client_email)), '');
    v_doc := case when length(i.client_document) in (11, 14) then i.client_document end;
    if v_doc is not null then
      select c.id, c.name, lower(c.email) into v_by_doc, v_doc_name, v_doc_email
      from public.clients c where c.tenant_id = v_commercial and c.document = v_doc
      order by c.created_at limit 1;
    end if;
    if v_email is not null then
      select c.id, c.name into v_by_email, v_email_name
      from public.clients c
      where c.tenant_id = v_commercial
        and (lower(c.email) = v_email
             or exists (select 1 from public.client_contacts cc where cc.client_id = c.id and cc.active and lower(cc.email) = v_email))
      order by (lower(c.email) = v_email) desc, c.created_at limit 1;
    end if;
    if v_by_doc is not null and v_by_email is not null and v_by_doc <> v_by_email then
      v_errors := v_errors || ('O CPF/CNPJ informado pertence ao cliente "' || v_doc_name || '", mas o e-mail '
        || v_email || ' pertence ao cliente "' || v_email_name || '". Corrija o CPF/CNPJ ou o e-mail e processe de novo.');
    elsif v_by_doc is not null and v_by_email is null and v_email is not null and v_doc_email is not null and v_doc_email <> v_email then
      v_errors := v_errors || ('O CPF/CNPJ informado já pertence ao cliente "' || v_doc_name || '" (e-mail ' || v_doc_email
        || '), diferente do e-mail desta venda (' || v_email || '). Confirme o CPF/CNPJ ou use o e-mail cadastrado e processe de novo.');
    end if;
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
  v_client := coalesce(v_by_email, v_by_doc);
  if v_client is null then
    insert into public.clients (tenant_id, name, email, phone, client_type, document, company_name, external_source, external_id)
    values (v_commercial, i.client_name, v_email, i.client_phone, i.client_type, v_doc,
            nullif(i.raw_payload #>> '{cliente,empresa}', ''), i.source, null)
    returning id into v_client;
  end if;
  perform private.link_client_access(v_client, v_email, i.client_name, i.client_phone);

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

revoke execute on function private.process_intake(uuid) from authenticated;
