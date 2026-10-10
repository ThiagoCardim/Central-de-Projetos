-- Acessos do cliente por projeto: vincular pessoas, escopo e nível.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tst;
grant usage on schema tst to authenticated, service_role;
create function tst.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALHOU: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create function tst.throws(stmt text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then raise notice 'ok - % (bloqueado: %)', msg, sqlerrm; return; end;
  raise exception 'FALHOU (deveria bloquear): %', msg;
end $$;
create function tst.login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',
    coalesce((select auth_user_id::text from public.profiles where email = p_email), ''), false);
end $$;
create function tst.uid(p_email text) returns uuid language sql as $$ select id from public.profiles where email = p_email $$;
create function tst.throws_like(stmt text, pat text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm not ilike '%' || pat || '%' then raise exception 'FALHOU (erro inesperado: %): %', sqlerrm, msg; end if;
    raise notice 'ok - % (bloqueado: %)', msg, sqlerrm; return;
  end;
  raise exception 'FALHOU (deveria bloquear): %', msg;
end $$;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "8101", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa de praia", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
select public.ingest_crm_webhook('pipefy', '{"card_id": "8102", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Apartamento", "area_m2": "90"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','eng@hq','adm@hq','cs@hq','col@hq','out@hq','iris@x.com']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Ana Líder', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Bruno Engenheiro', 'eng@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab Arquiteta', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Fora do Projeto', 'out@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Iris Cliente', 'iris@x.com', 'client', null, 'b2c'),
       ('00000000-0000-4000-8000-000000000001', 'Equipe Interna', 'equipe@youcon.com.br', 'collaborator', 'clt', null);
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
-- Contas de teste com senha criada (entraram no portal).
update public.profiles set last_seen_at = now() where email in ('iris@x.com');
-- Novos usuários criados pelo vínculo ganham conta no Auth no convite; no teste, criamos na hora.
create function tst.auth_for(p_email text) returns void language plpgsql security definer as $$
declare v uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.sub', '', false);
  insert into auth.users (id, email) values (v, p_email) on conflict do nothing;
  update public.profiles set auth_user_id = (select id from auth.users where email = p_email) where email = p_email and auth_user_id is null;
end $$;

create function tst.pid(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
create function tst.ps(p_ext text) returns uuid language sql as $$
  select ps.id from public.project_services ps where ps.project_id = tst.pid(p_ext) limit 1 $$;
create function tst.sees(p_ext text) returns boolean language sql as $$ select private.can_view_project(tst.pid(p_ext)) $$;
create function tst.contact(p_email text) returns public.client_contacts language sql security definer as $$
  select cc.* from public.client_contacts cc join public.profiles pr on pr.id = cc.profile_id where pr.email = p_email $$;
create function tst.people(p_ext text) returns text language sql security definer as $$
  select string_agg(pr.email::text, ',' order by pr.email) from public.client_contacts cc join public.profiles pr on pr.id = cc.profile_id
  where private.client_contact_covers(cc, tst.pid(p_ext)) $$;
create function tst.doc_status(p uuid) returns text language sql security definer as $$ select status from public.project_documents where id = p $$;
grant execute on all functions in schema tst to authenticated;

select tst.ok((tst.contact('iris@x.com')).is_primary and (tst.contact('iris@x.com')).scope = 'all', 'Cliente da venda é o contato principal, com acesso a tudo');
select tst.login('iris@x.com'); set role authenticated;
select tst.ok(tst.sees('8101') and tst.sees('8102'), 'Contato principal vê os dois projetos do cliente');
reset role;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid('8101'), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
-- Liderança vincula uma pessoa só para acompanhar a Casa de praia
create temp table r1 as select public.client_access_add(tst.pid('8101'), 'Marina Arquiteta', 'Marina@Studio.com ', null, 'Arquiteta parceira', false, false) j;
grant select on r1 to authenticated;
select tst.ok(((select j from r1) ->> 'send_invite')::boolean and ((select j from r1) ->> 'new_user')::boolean, 'E-mail novo vira usuário cliente com convite');
select tst.throws_like(format('select public.client_access_add(%L, %L, %L, null, null, false, true)', tst.pid('8101'), 'Marina', 'marina@studio.com'),
  'já tem acesso', 'Não vincula duas vezes');
select tst.throws_like(format('select public.client_access_add(%L, %L, %L, null, null, false, true)', tst.pid('8101'), 'Equipe', 'equipe@youcon.com.br'),
  'equipe', 'E-mail da equipe não vira cliente');
select tst.throws_like(format('select public.client_access_add(%L, %L, %L, null, null, false, true)', tst.pid('8101'), 'X', 'sem-arroba'),
  'e-mail válido', 'E-mail inválido recusado');
reset role;
select tst.auth_for('marina@studio.com');
select tst.ok((select role from public.profiles where email = 'marina@studio.com') = 'client'
  and (select tenant_id from public.profiles where email = 'marina@studio.com') = (select c.tenant_id from public.clients c join public.projects p on p.client_id = c.id where p.external_id = '8101'),
  'Usuário criado como cliente na unidade do cliente');
select tst.ok(tst.people('8101') = 'iris@x.com,marina@studio.com' and tst.people('8102') = 'iris@x.com', 'Marina entra só na Casa de praia');

select tst.login('marina@studio.com'); set role authenticated;
select tst.ok(tst.sees('8101') and not tst.sees('8102'), 'Marina vê só o projeto vinculado');
select tst.ok(not (public.project_deliveries(tst.pid('8101')) ->> 'can_decide')::boolean, 'Entregas: Marina só acompanha');
select tst.throws_like(format('select public.delivery_request_revision(%L, %L, %L, null)', tst.pid('8101'), tst.ps('8101'), '{"Ajuste"}'),
  'acompanhar', 'Quem acompanha não pede revisão');
select tst.throws_like(format('select public.delivery_approve(%L, %L, null)', tst.pid('8101'), tst.ps('8101')), 'acompanhar', 'Quem acompanha não aprova');
select tst.throws(format('select public.client_access_add(%L, %L, %L, null, null, false, true)', tst.pid('8101'), 'Primo', 'primo@x.com'),
  'Quem não é o contato principal não vincula ninguém');
select tst.ok((public.project_client_access(tst.pid('8101')) -> 'people' -> 0 ->> 'email') is null, 'Quem não gerencia não vê o e-mail dos outros');
reset role;
select tst.login('lid@hq'); set role authenticated;
create temp table xd as select public.document_extra_add(tst.pid('8101'), 'Planta do condomínio', null, false) id;
grant select on xd to authenticated;
reset role;
select tst.login('marina@studio.com'); set role authenticated;
select tst.throws_like(format('select public.document_file_add(%L, %L, %L, null, null, null, %L)', (select id from xd), 'link', 'Planta', 'https://x.com/a'),
  'acompanhar', 'Quem acompanha não envia documento');
select tst.ok(not private.document_file_writable(tst.pid('8101')::text, (select id from xd)::text), 'Nem sobe arquivo direto no armazenamento');
reset role;

-- Contato principal vincula alguém a todos os projetos, com decisão
select tst.login('iris@x.com'); set role authenticated;
select tst.ok((public.project_client_access(tst.pid('8101')) ->> 'can_manage')::boolean and (public.project_client_access(tst.pid('8101')) ->> 'can_grant_all')::boolean,
  'Contato principal gerencia os acessos');
select public.client_access_add(tst.pid('8101'), 'João Souza', 'joao@x.com', '11999990000', 'Cônjuge', true, true);
select tst.throws(format('select public.client_access_update(%L, %L, null, true, true)', tst.pid('8101'), (tst.contact('iris@x.com')).id), 'Ninguém altera o próprio acesso');
reset role;
select tst.auth_for('joao@x.com');
select tst.login('joao@x.com'); set role authenticated;
select tst.ok(tst.sees('8101') and tst.sees('8102') and (public.project_deliveries(tst.pid('8101')) ->> 'can_decide')::boolean, 'João vê tudo e decide');
select public.document_file_add((select id from xd), 'link', 'Planta', null, null, null, 'https://drive.google.com/p');
select tst.ok(tst.doc_status((select id from xd)) = 'submitted', 'Quem decide envia documento');
select tst.throws(format('select public.client_access_remove(%L, %L, true)', tst.pid('8101'), (tst.contact('iris@x.com')).id), 'Cliente que não é o principal não remove acessos');
reset role;

-- Quem mais gerencia
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.client_access_add(%L, %L, %L, null, null, false, true)', tst.pid('8101'), 'Primo', 'primo@x.com'), 'Colaborador não vincula');
reset role;
select tst.login('cs@hq'); set role authenticated;
select tst.ok(((public.client_access_add(tst.pid('8102'), 'Pedro Obra', 'pedro@x.com', null, 'Engenheiro da obra', false, false)) ->> 'send_invite')::boolean, 'CS vincula pelo projeto');
reset role;
select tst.ok(tst.people('8102') = 'iris@x.com,joao@x.com,pedro@x.com', 'Apartamento com três pessoas');

-- Avisos só para quem tem acesso
select private.notify_project_clients(tst.pid('8101'), 'tst_kind', 'Teste', 'x', null, null, '{}'::jsonb);
select tst.ok((select string_agg(pr.email::text, ',' order by pr.email) from public.notifications n join public.profiles pr on pr.id = n.recipient_profile_id where n.kind = 'tst_kind')
  = 'iris@x.com,joao@x.com,marina@studio.com', 'Avisos do projeto vão só para quem tem acesso a ele');

-- Alterar e remover
select tst.login('lid@hq'); set role authenticated;
select public.client_access_update(tst.pid('8101'), (tst.contact('marina@studio.com')).id, 'Arquiteta', false, true);
reset role;
select tst.login('marina@studio.com'); set role authenticated;
select tst.ok((public.project_deliveries(tst.pid('8101')) ->> 'can_decide')::boolean, 'Marina passa a decidir');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.client_access_remove(tst.pid('8101'), (tst.contact('joao@x.com')).id, false);
reset role;
select tst.login('joao@x.com'); set role authenticated;
select tst.ok(not tst.sees('8101') and tst.sees('8102'), 'João sai só da Casa de praia e continua no Apartamento');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.client_access_remove(tst.pid('8101'), (tst.contact('marina@studio.com')).id, false);
reset role;
select tst.ok(not (tst.contact('marina@studio.com')).active, 'Sem nenhum projeto, o vínculo da Marina fica inativo');
select tst.login('marina@studio.com'); set role authenticated;
select tst.ok(not tst.sees('8101'), 'Marina não vê mais o projeto');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.client_access_add(tst.pid('8101'), null, 'marina@studio.com', null, null, false, false);
reset role;
select tst.ok((tst.contact('marina@studio.com')).active and (tst.contact('marina@studio.com')).scope = 'projects', 'E-mail já cadastrado volta sem novo usuário');
select tst.ok((select count(*) from public.notifications n join public.profiles pr on pr.id = n.recipient_profile_id
               where pr.email = 'joao@x.com' and n.kind = 'client_access_granted') = 0, 'Sem aviso para quem nunca entrou (recebe o convite)');

-- Reenvio do convite
select tst.login('lid@hq'); set role authenticated;
select tst.ok(public.client_access_invite_info(tst.pid('8101'), (tst.contact('marina@studio.com')).id) ->> 'email' = 'marina@studio.com', 'Convite pendente pode ser reenviado');
select tst.throws_like(format('select public.client_access_invite_info(%L, %L)', tst.pid('8101'), (tst.contact('iris@x.com')).id), 'já entrou', 'Quem já entrou não recebe convite de novo');
reset role;
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.project_client_access(%L)', tst.pid('8101')), 'Quem não é do projeto não vê os acessos');
reset role;
