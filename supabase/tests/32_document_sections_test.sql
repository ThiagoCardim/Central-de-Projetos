-- Documentos: seções, titular PF/PJ, pergunta ao cliente e prazo por projeto.
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
insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','eng@hq','adm@hq','cs@hq','col@hq','out@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Ana Líder', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Bruno Engenheiro', 'eng@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab Arquiteta', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Fora do Projeto', 'out@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Iris Cliente', 'cli@x', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

select tst.login('ga@hq'); set role authenticated;
create temp table sx as select public.document_section_save(null, 'Documentação do proprietário') own,
  public.document_section_save(null, 'Documentação do imóvel') prop,
  public.document_section_save(null, 'Documentação para aprovação em condomínio') cond,
  public.document_question_save(null, 'O imóvel fica em condomínio?', 'Loteamento fechado também conta.') q;
grant select on sx to authenticated;
select public.document_type_save(null, 'RG ou CNH do proprietário', null, true, null, (select own from sx), 'pf', null);
select public.document_type_save(null, 'Cartão CNPJ atualizado', null, true, null, (select own from sx), 'pj', null);
select public.document_type_save(null, 'Matrícula atualizada do imóvel', null, true, null, (select prop from sx), null, null);
select public.document_type_save(null, 'Convenção de condomínio', null, true, null, (select cond from sx), null, (select q from sx));
select public.document_type_save(null, 'Manual de obras', null, true, null, (select cond from sx), null, (select q from sx));
-- Seção do imóvel antes da do proprietário
select public.document_sections_reorder(array[(select prop from sx), (select own from sx), (select cond from sx)]);
select tst.throws(format('select public.document_section_delete(%L)', (select own from sx)), 'Seção com documentos não é excluída');
select tst.throws(format('select public.document_question_delete(%L)', (select q from sx)), 'Pergunta em uso não é excluída');
select tst.throws(format('select public.document_type_save(null, %L, null, false, null, null, %L, null)', 'Teste', 'xx'), 'Titular inválido');
select tst.ok(jsonb_array_length(public.document_types_list() -> 'sections') = 3 and jsonb_array_length(public.document_types_list() -> 'questions') = 1,
  'Lista padrão com seções e pergunta');
reset role;

-- Dois projetos: pessoa física (CPF) e jurídica (CNPJ)
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "7901", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C", "documento": "123.456.789-01"},
  "projeto": {"nome": "Casa Iris", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
select public.ingest_crm_webhook('pipefy', '{"card_id": "7902", "cliente": {"nome": "Construtora Alfa", "email": "alfa@x.com", "tipo": "B2B", "documento": "12.345.678/0001-90"},
  "projeto": {"nome": "Edifício Alfa", "area_m2": "900"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Iris Cliente' from public.projects p where p.external_id = '7901';
create function tst.pid(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
create function tst.names(p_ext text) returns text language sql security definer as $$
  select string_agg(x ->> 'name', ' > ') from jsonb_array_elements(private.project_documents(tst.pid(p_ext)) -> 'items') x $$;
create function tst.open_waits(p_ext text) returns int language sql security definer as $$
  select count(*)::int from public.client_waits where project_id = tst.pid(p_ext) and source = 'documents' and closed_at is null $$;
grant execute on all functions in schema tst to authenticated;

select tst.ok(private.project_holder(tst.pid('7901')) = 'pf' and private.project_holder(tst.pid('7902')) = 'pj', 'Titular vem do CPF/CNPJ do cliente');
select tst.ok(tst.names('7901') = 'Matrícula atualizada do imóvel > RG ou CNH do proprietário', 'Pessoa física: documentos de PF, por seção');
select tst.ok(tst.names('7902') = 'Matrícula atualizada do imóvel > Cartão CNPJ atualizado', 'Pessoa jurídica: documentos de PJ');
select tst.ok((select x ->> 'section' from jsonb_array_elements(private.project_documents(tst.pid('7901')) -> 'items') x limit 1) = 'Documentação do imóvel',
  'Documento traz a seção');

-- Pergunta do condomínio
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid('7901'), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;
select tst.login('cli@x'); set role authenticated;
select tst.ok((public.project_documents(tst.pid('7901')) -> 'questions' -> 0 ->> 'answer') is null
  and (public.project_documents(tst.pid('7901')) -> 'questions' -> 0 ->> 'can_answer')::boolean, 'Cliente vê a pergunta sem resposta');
select public.document_file_add((x ->> 'id')::uuid, 'link', 'Doc', null, null, null, 'https://drive.google.com/a')
  from jsonb_array_elements(public.project_documents(tst.pid('7901')) -> 'items') x;
reset role;
select tst.ok(tst.open_waits('7901') = 1, 'Pergunta sem resposta mantém o prazo aberto');
select tst.login('cli@x'); set role authenticated;
select public.document_answer(tst.pid('7901'), (select q from sx), true);
select tst.ok(tst.names('7901') = 'Matrícula atualizada do imóvel > RG ou CNH do proprietário > Convenção de condomínio > Manual de obras',
  'Respondeu Sim: documentos do condomínio entram no fim, na seção deles');
select public.document_answer(tst.pid('7901'), (select q from sx), false);
select tst.ok(tst.names('7901') = 'Matrícula atualizada do imóvel > RG ou CNH do proprietário', 'Respondeu Não: saem');
reset role;
select tst.ok(tst.open_waits('7901') = 0, 'Tudo respondido e enviado: prazo fecha');
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.document_answer(%L, %L, true)', tst.pid('7901'), (select q from sx)), 'Quem não é do projeto não responde');
reset role;

-- Prazo por projeto (projetos antigos sem prazo automático)
select tst.ok((select documents_wait from public.projects where external_id = '7902'), 'Projeto novo já nasce com prazo automático');
select tst.login('lid@hq'); set role authenticated;
select public.document_answer(tst.pid('7901'), (select q from sx), true);
reset role;
select tst.ok(tst.open_waits('7901') = 1, 'Novos obrigatórios reabrem o prazo');
select tst.login('lid@hq'); set role authenticated;
select public.documents_wait_set(tst.pid('7901'), false);
reset role;
select tst.ok(tst.open_waits('7901') = 0 and (select close_source from public.client_waits where project_id = tst.pid('7901') and source = 'documents' order by created_at desc limit 1) = 'cancelled',
  'Liderança desliga o prazo: espera cancelada');
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.documents_wait_set(%L, true)', tst.pid('7901')), 'Colaborador não liga o prazo');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.documents_wait_set(tst.pid('7901'), true);
reset role;
select tst.ok(tst.open_waits('7901') = 1, 'Ligado de novo: prazo volta a correr');
