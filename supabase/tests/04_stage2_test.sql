-- Testes da Etapa 2: webhook idempotente, validação, cliente/projeto, pacotes,
-- serviço adicional, distribuição, atribuição de equipe e permissões.
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
grant execute on all functions in schema tst to authenticated, service_role;

-- Usuários da franqueadora
insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','arq@hq','pj@hq','adm@fa','lid@fa']) e;
-- (perfis são vinculados automaticamente pelo trigger de convite)
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', null),
       ('00000000-0000-4000-8000-000000000001', 'Líder HQ', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta HQ', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Engenheiro PJ', 'pj@hq', 'collaborator', 'pj');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

-- -----------------------------------------------------------------------------
-- Utilitários
-- -----------------------------------------------------------------------------
select tst.ok(private.parse_decimal('R$ 12.500,50') = 12500.50, 'Valor em reais é interpretado');
select tst.ok(private.parse_decimal('120,5') = 120.5, 'Área com vírgula é interpretada');
select tst.ok(private.parse_date('05/10/2026') = '2026-10-05', 'Data dd/mm/aaaa é interpretada');
select tst.ok(private.parse_date('2026-10-05T10:00:00Z') = '2026-10-05', 'Data ISO é interpretada');
select tst.ok(private.split_services('"Arquitetura; Complementares"') = array['Arquitetura','Complementares'], 'Serviços em texto são separados');
select tst.ok(private.split_services('"[\"SPDA\",\"Elétrico\"]"') = array['SPDA','Elétrico'], 'Lista do Pipefy em texto é aceita');
select tst.ok(jsonb_array_length(private.resolve_services(array['projeto arquitetonico','Complementares']) -> 'resolved') = 3,
  'Nome sem acento + pacote expandem para 3 serviços');
select tst.ok(private.resolve_services(array['Paisagismo']) -> 'unknown' = '["Paisagismo"]', 'Serviço fora do catálogo é apontado');

-- -----------------------------------------------------------------------------
-- Webhook: novo projeto (sem franquias → Franqueadora executa)
-- -----------------------------------------------------------------------------
set role service_role;
select tst.ok(public.ingest_crm_webhook('pipefy', '{
  "card_id": "1001", "tipo": "novo_projeto",
  "cliente": {"nome": "Maria Silva", "email": "MARIA@exemplo.com", "telefone": "35 99999-0000", "documento": "123.456.789-09", "tipo": "B2C"},
  "projeto": {"nome": "Residência Silva", "tipo": "Residencial", "cidade": "Poços de Caldas", "uf": "mg", "area_m2": "180,5"},
  "servicos": "Projeto Arquitetônico, Projetos Complementares",
  "valor_contrato": "R$ 18.900,00", "data_fechamento": "01/10/2026"
}'::jsonb) ->> 'status' = 'processed', 'Webhook válido gera projeto');
reset role;

select tst.ok((select status from public.projects where external_id = '1001') = 'awaiting_team_assignment', 'Sem franquias: projeto vai direto para atribuição de equipe');
select tst.ok((select delivery_tenant_id from public.projects where external_id = '1001') = '00000000-0000-4000-8000-000000000001', 'Execução pela Franqueadora');
select tst.ok((select allocation_method from public.project_allocations a join public.projects p on p.id = a.project_id where p.external_id = '1001') = 'automatic_headquarters', 'Distribuição automática registrada');
select tst.ok((select count(*) from public.project_services ps join public.projects p on p.id = ps.project_id where p.external_id = '1001') = 3, 'Pacote expandido em serviços contratados');
select tst.ok((select area_m2 from public.projects where external_id = '1001') = 180.5, 'Área do projeto registrada');
select tst.ok((select state from public.projects where external_id = '1001') = 'MG', 'UF normalizada');
select tst.ok((select document from public.clients where name = 'Maria Silva') = '12345678909', 'Documento salvo só com dígitos');
select tst.ok((select contract_value from public.project_intakes where external_id = '1001') = 18900, 'Valor do contrato registrado');
select tst.ok(exists (select 1 from public.notifications where kind = 'project_awaiting_team' and recipient_role = 'leader'), 'Líder recebe aviso de novo projeto');

-- Idempotência
set role service_role;
select tst.ok((public.ingest_crm_webhook('pipefy', '{"card_id": "1001", "cliente": {"nome": "Outro"}}'::jsonb) ->> 'duplicate')::boolean,
  'Webhook duplicado é reconhecido');
reset role;
select tst.ok((select count(*) from public.projects where external_id = '1001') = 1, 'Webhook duplicado não duplica projeto');
select tst.ok((select count(*) from public.project_intakes where external_id = '1001') = 1, 'Webhook duplicado não duplica entrada');

-- Cliente reaproveitado pelo documento
set role service_role;
select public.ingest_crm_webhook('pipefy', '{
  "card_id": "1002", "cliente": {"nome": "Maria S.", "documento": "12345678909", "tipo": "b2c"},
  "projeto": {"nome": "Casa de Praia"}, "servicos": "Design de Interiores"}'::jsonb);
reset role;
select tst.ok((select count(*) from public.clients where document = '12345678909') = 1, 'Cliente existente é reaproveitado (um cliente, vários projetos)');
select tst.ok((select area_m2 from public.projects where external_id = '1002') is null, 'Área não informada fica vazia (nunca assumida)');

-- -----------------------------------------------------------------------------
-- Validação
-- -----------------------------------------------------------------------------
set role service_role;
select tst.ok(public.ingest_crm_webhook('pipefy', '{"card_id": "1003", "cliente": {"nome": "João", "tipo": "b2c"}, "servicos": "SPDA, Paisagismo"}'::jsonb) ->> 'status' = 'error',
  'Entrada inválida fica com erro');
select tst.ok(public.ingest_crm_webhook('pipefy', '{"cliente": {"nome": "Sem id"}}'::jsonb) ->> 'status' = 'error', 'Payload sem card_id é rejeitado');
reset role;
select tst.ok((select validation_error from public.project_intakes where external_id = '1003') like '%Paisagismo%', 'Erro explica serviço desconhecido');
select tst.ok((select validation_error from public.project_intakes where external_id = '1003') like '%SPDA não está disponível para clientes B2C%', 'Erro explica regra B2C/B2B');
select tst.ok(not exists (select 1 from public.projects where external_id = '1003'), 'Entrada com erro não cria projeto');

-- Correção + reprocessamento pelo ADM Global
select tst.login('ga@hq'); set role authenticated;
select tst.ok(public.reprocess_intake((select id from public.project_intakes where external_id = '1003'),
  '{"services": "Projeto Estrutural"}'::jsonb) ->> 'status' = 'processed', 'Corrigir e reprocessar cria o projeto');
select tst.throws($$select public.reprocess_intake((select id from public.project_intakes where external_id = '1001'), '{}'::jsonb)$$,
  'Entrada já processada não é reprocessada');
select tst.ok((public.create_manual_intake('{"cliente": {"nome": "Cliente Balcão", "tipo": "b2c"}, "servicos": "Orçamento Estimativo"}'::jsonb) ->> 'status') = 'processed',
  'Entrada manual cria projeto');
reset role; select tst.login('');
select tst.ok((select raw_payload ->> 'cliente' from public.project_intakes where external_id = '1003') like '%João%', 'Payload original preservado após correção');

-- Colaborador não acessa a Central de Entrada
select tst.login('arq@hq'); set role authenticated;
select tst.ok((select count(*) from public.project_intakes) = 0, 'Colaborador não vê a Central de Entrada');
select tst.throws($$select public.create_manual_intake('{"cliente": {"nome": "X", "tipo": "b2c"}, "servicos": "SPDA"}'::jsonb)$$, 'Colaborador não cria entrada manual');
select tst.throws($$select public.ingest_crm_webhook('pipefy', '{"card_id": "x"}'::jsonb)$$, 'App não chama o webhook diretamente');
reset role; select tst.login('');

-- -----------------------------------------------------------------------------
-- Serviço adicional
-- -----------------------------------------------------------------------------
set role service_role;
select tst.ok(public.ingest_crm_webhook('pipefy', '{"card_id": "1004", "tipo": "servico_adicional", "projeto_referencia": "1001",
  "servicos": "Projeto Estrutural, Projeto Elétrico"}'::jsonb) ->> 'status' = 'processed', 'Aditivo localiza projeto pelo card original');
select tst.ok(public.ingest_crm_webhook('pipefy', '{"card_id": "1005", "tipo": "servico_adicional", "projeto_referencia": "YC-0000-9999",
  "servicos": "SPDA"}'::jsonb) ->> 'status' = 'error', 'Aditivo sem projeto existente fica com erro');
reset role;
select tst.ok((select count(*) from public.project_services ps join public.projects p on p.id = ps.project_id
               where p.external_id = '1001' and ps.status = 'pending_review') = 1, 'Aditivo adiciona só o serviço novo, para revisão');
select tst.ok((select count(*) from public.projects where external_id in ('1001','1004')) = 1, 'Aditivo não cria novo projeto');
select tst.ok(exists (select 1 from public.notifications where kind = 'service_added'), 'Líder recebe aviso de novo serviço');

-- -----------------------------------------------------------------------------
-- Atribuição de equipe
-- -----------------------------------------------------------------------------
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format($$select public.assign_project_team(%L, '[{"project_role":"architecture","user_id":"%s"}]'::jsonb)$$,
  (select id from public.projects where external_id = '1001'), (select id from public.profiles where email = 'arq@hq')),
  'Líder do Projeto é obrigatório');
select tst.ok((public.assign_project_team((select id from public.projects where external_id = '1001'), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', (select id from public.profiles where email = 'lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', (select id from public.profiles where email = 'arq@hq')),
  jsonb_build_object('project_role', 'engineering',  'user_id', (select id from public.profiles where email = 'pj@hq'))
)) ->> 'started')::boolean, 'Confirmar equipe inicia o projeto');
reset role; select tst.login('');
select tst.ok((select status from public.projects where external_id = '1001') = 'in_progress', 'Projeto em andamento após equipe');
select tst.ok((select t.employment_type from public.project_team t join public.profiles p on p.id = t.user_id
               where p.email = 'pj@hq' and t.active) = 'pj', 'Vínculo CLT/PJ registrado na equipe');
select tst.ok(not exists (select 1 from public.notifications n join public.projects p on p.id = n.entity_id
                          where p.external_id = '1001' and n.kind = 'project_awaiting_team' and n.resolved_at is null),
  'Aviso "aguardando equipe" é resolvido');
select tst.ok((select count(*) from public.notifications where kind = 'team_assigned') = 3, 'Cada integrante recebe aviso');
select tst.ok(exists (select 1 from public.audit_logs where action = 'team_confirmed_project_started'), 'Confirmação de equipe é auditada');

-- Colaborador agora vê o projeto; troca de equipe remove acesso
select tst.login('pj@hq'); set role authenticated;
select tst.ok(exists (select 1 from public.projects where external_id = '1001'), 'Equipe atribuída libera acesso ao projeto');
select tst.throws(format($$select public.assign_project_team(%L, '[]'::jsonb)$$, (select id from public.projects where external_id = '1001')),
  'Colaborador não altera a equipe');
reset role; select tst.login('');
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team((select id from public.projects where external_id = '1001'), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', (select id from public.profiles where email = 'lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', (select id from public.profiles where email = 'arq@hq'))));
reset role; select tst.login('');
select tst.login('pj@hq'); set role authenticated;
select tst.ok(not exists (select 1 from public.projects where external_id = '1001'), 'Removido da equipe perde o acesso');
reset role; select tst.login('');

-- -----------------------------------------------------------------------------
-- Com franquias: distribuição manual pela Franqueadora
-- -----------------------------------------------------------------------------
insert into public.tenants (id, name, type, parent_tenant_id, slug) values
  ('00000000-0000-4000-8000-0000000000fa', 'Franquia Sul', 'franquia', '00000000-0000-4000-8000-000000000001', 'franquia-sul');
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-0000000000fa', 'Líder Sul', 'lid@fa', 'leader', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "2001", "unidade_origem": "franquia-sul",
  "cliente": {"nome": "Empresa Alfa", "tipo": "b2b", "documento": "12.345.678/0001-95"}, "servicos": "SPDA, Estudo de Viabilidade"}'::jsonb);
reset role;
select tst.ok((select status from public.projects where external_id = '2001') = 'awaiting_allocation', 'Com franquias: projeto aguarda distribuição');
select tst.ok((select origin_tenant_id from public.projects where external_id = '2001') = '00000000-0000-4000-8000-0000000000fa', 'Unidade de origem do lead registrada');
select tst.ok(exists (select 1 from public.notifications where kind = 'project_awaiting_allocation' and recipient_role = 'global_admin'), 'ADM Global é avisado para distribuir');

select tst.login('lid@fa'); set role authenticated;
select tst.throws(format($$select public.allocate_project(%L, %L)$$, (select id from public.projects where external_id = '2001'),
  '00000000-0000-4000-8000-0000000000fa'), 'Franquia não distribui projetos');
reset role; select tst.login('');

select tst.login('ga@hq'); set role authenticated;
select public.allocate_project((select id from public.projects where external_id = '2001'), '00000000-0000-4000-8000-0000000000fa', 'Território Sul');
reset role; select tst.login('');
select tst.ok((select delivery_tenant_id from public.projects where external_id = '2001') = '00000000-0000-4000-8000-0000000000fa', 'Unidade executora definida');
select tst.ok((select status from public.projects where external_id = '2001') = 'awaiting_team_assignment', 'Após distribuir, aguarda equipe');
select tst.ok((select commercial_tenant_id from public.projects where external_id = '2001') = '00000000-0000-4000-8000-000000000001', 'Comercial, origem e execução independentes');

select id as arq_id from public.profiles where email = 'arq@hq' \gset
select id as p2001 from public.projects where external_id = '2001' \gset
select tst.login('lid@fa'); set role authenticated;
select tst.ok(exists (select 1 from public.projects where external_id = '2001'), 'Unidade executora passa a ver o projeto');
select tst.throws(format($$select public.assign_project_team(%L, '[{"project_role":"project_lead","user_id":"%s"}]'::jsonb)$$,
  :'p2001', :'arq_id'), 'Equipe só com pessoas da unidade executora');
reset role; select tst.login('');

select tst.login('lid@hq'); set role authenticated;
select tst.ok(exists (select 1 from public.projects where external_id = '2001'), 'Unidade comercial (HQ) continua vendo o projeto que vendeu');
select tst.throws(format($$select public.assign_project_team(%L, '[{"project_role":"project_lead","user_id":"%s"}]'::jsonb)$$,
  (select id from public.projects where external_id = '2001'), (select id from public.profiles where email = 'lid@hq')),
  'Unidade comercial não define a equipe de outra unidade executora');
reset role; select tst.login('');

drop schema tst cascade;
