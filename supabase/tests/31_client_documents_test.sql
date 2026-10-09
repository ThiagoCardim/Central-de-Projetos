-- Documentos do cliente: lista padrão, envio, conferência, extras e prazo.
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

-- Lista padrão (ADM Global)
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
create temp table ty as select
  public.document_type_save(null, 'Matrícula do imóvel', 'Atualizada, emitida há no máximo 30 dias', true, null) mat,
  public.document_type_save(null, 'Levantamento topográfico', null, true, array['projeto_arquitetonico']) topo,
  public.document_type_save(null, 'Convenção do condomínio', null, false, array['aprovacao_projeto_legal']) conv,
  public.document_type_save(null, 'Fotos do terreno', 'Pode ser pelo celular', false, null) fotos;
grant select on ty to authenticated;
select tst.throws($$select public.document_type_save(null, 'X', null, false, null)$$, 'Nome curto recusado');
select tst.throws($$select public.document_type_save(null, 'Planta', null, false, array['nao_existe'])$$, 'Serviço inexistente recusado');
select public.document_types_reorder(array[(select topo from ty), (select mat from ty), (select fotos from ty), (select conv from ty)]);
select tst.ok((select string_agg(x ->> 'name', ' > ') from jsonb_array_elements(public.document_types_list() -> 'types') x)
  = 'Levantamento topográfico > Matrícula do imóvel > Fotos do terreno > Convenção do condomínio', 'Lista padrão reordenada');
select tst.throws(format('select public.document_types_reorder(%L)', array[(select topo from ty)]), 'Reordenar exige a lista inteira');
reset role;
select tst.login('lid@hq'); set role authenticated;
select tst.ok(not (public.document_types_list() ->> 'can_edit')::boolean, 'Liderança vê a lista padrão sem editar');
select tst.throws($$select public.document_type_save(null, 'Planta', null, false, null)$$, 'Só o ADM Global altera a lista padrão');
reset role;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "7801", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Iris", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Iris Cliente' from public.projects p where p.external_id = '7801';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '7801' $$;
create function tst.doc(p_name text) returns public.project_documents language sql security definer as $$
  select * from public.project_documents where project_id = tst.pid() and name = p_name $$;
create function tst.wait() returns public.client_waits language sql security definer as $$
  select * from public.client_waits where project_id = tst.pid() and source = 'documents' order by created_at desc limit 1 $$;
create function tst.open_waits() returns int language sql security definer as $$
  select count(*)::int from public.client_waits where project_id = tst.pid() and source = 'documents' and closed_at is null $$;
create function tst.notes(p_email text, p_kind text) returns int language sql security definer as $$
  select count(*)::int from public.notifications where recipient_profile_id = tst.uid(p_email) and kind = p_kind $$;
create function tst.file_of(p_name text) returns uuid language sql security definer as $$
  select f.id from public.project_document_files f join public.project_documents d on d.id = f.document_id
  where d.project_id = tst.pid() and d.name = p_name and f.archived_at is null order by f.created_at desc limit 1 $$;
grant execute on all functions in schema tst to authenticated;

-- Antes de começar o projeto, o cliente já vê a lista (sem prazo correndo)
select tst.login('cli@x'); set role authenticated;
select tst.ok((select string_agg(x ->> 'name', ' > ') from jsonb_array_elements(public.project_documents(tst.pid()) -> 'items') x)
  = 'Levantamento topográfico > Matrícula do imóvel > Fotos do terreno', 'Projeto recebe a lista padrão aplicável, na ordem');
select tst.ok((public.project_documents(tst.pid()) -> 'progress' ->> 'percent')::int = 0 and public.project_documents(tst.pid()) -> 'wait' = 'null'::jsonb,
  'Progresso 0% e nenhum prazo antes de o projeto começar');
select tst.ok((public.project_documents(tst.pid()) ->> 'can_upload')::boolean and not (public.project_documents(tst.pid()) ->> 'can_manage')::boolean,
  'Cliente envia, mas não altera a lista');
reset role;

-- Projeto começa: prazo dos obrigatórios
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
select public.set_task_responsible(pt.id, tst.uid('col@hq'))
  from public.project_tasks pt where pt.project_id = tst.pid() and pt.code = 'estudo_preliminar';
reset role;
select tst.ok(tst.open_waits() = 1 and (tst.wait()).due_on = public.add_business_days(private.today_br() + 1, 5, private.client_wait_cal(tst.pid())),
  'Projeto em andamento abre o prazo dos documentos obrigatórios (5 dias úteis)');
select tst.login('lid@hq'); set role authenticated;
select tst.ok((public.project_client_waits(tst.pid()) -> 'waits' -> 0 ->> 'can_return')::boolean is false
  and (public.project_client_waits(tst.pid()) -> 'waits' -> 0 ->> 'can_waive')::boolean, 'Espera dos documentos não tem "Cliente retornou", mas pode ser abonada');
reset role;

-- Cliente envia
select tst.login('cli@x'); set role authenticated;
select public.document_file_add((tst.doc('Matrícula do imóvel')).id, 'link', 'Matrícula', null, null, null, 'https://drive.google.com/m');
select tst.ok((tst.doc('Matrícula do imóvel')).status = 'submitted' and tst.open_waits() = 1, 'Matrícula enviada; ainda falta obrigatório');
select tst.throws(format('select public.document_file_add(%L, %L, %L, %L, null, 10, null)', (tst.doc('Levantamento topográfico')).id, 'file', 'a.pdf', 'outro/lugar/a.pdf'),
  'Arquivo fora da pasta do documento');
select public.document_file_add((tst.doc('Levantamento topográfico')).id, 'file', 'topo.pdf',
  tst.pid() || '/' || (tst.doc('Levantamento topográfico')).id || '/x.pdf', 'application/pdf', 2048, null);
select tst.ok(tst.open_waits() = 0 and (tst.wait()).close_source = 'portal', 'Obrigatórios enviados fecham o prazo');
select tst.ok(private.document_file_writable(tst.pid()::text, (tst.doc('Fotos do terreno')).id::text)
  and private.document_file_readable(tst.pid()::text, (tst.doc('Fotos do terreno')).id::text), 'Cliente sobe e baixa arquivos do documento');
select tst.ok((public.project_documents(tst.pid()) -> 'progress' ->> 'required_sent')::int = 2
  and (public.project_documents(tst.pid()) -> 'progress' ->> 'percent')::int = 0, 'Enviado ainda não conta como aprovado');
reset role;
select tst.ok(tst.notes('lid@hq', 'document_submitted') = 2 and tst.notes('eng@hq', 'document_submitted') = 2, 'Liderança avisada dos envios');

-- Conferência
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.document_review(%L, true, null)', (tst.doc('Matrícula do imóvel')).id), 'Quem não é do projeto não confere');
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.document_review(%L, false, %L)', (tst.doc('Levantamento topográfico')).id, 'x'), 'Reenvio exige explicação');
select public.document_review((tst.doc('Levantamento topográfico')).id, false, 'Arquivo ilegível, envie em PDF com melhor resolução');
select public.document_review((tst.doc('Matrícula do imóvel')).id, true, null);
reset role;
select tst.ok((tst.doc('Levantamento topográfico')).status = 'rejected' and (tst.doc('Levantamento topográfico')).round = 2
  and tst.notes('cli@x', 'document_rejected') = 1, 'Reenvio pedido: cliente avisado, nova rodada');
select tst.ok(tst.open_waits() = 1, 'Obrigatório devolvido reabre o prazo');
select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length((select x from jsonb_array_elements(public.project_documents(tst.pid()) -> 'items') x where x ->> 'name' = 'Levantamento topográfico') -> 'history') = 1
  and jsonb_array_length((select x from jsonb_array_elements(public.project_documents(tst.pid()) -> 'items') x where x ->> 'name' = 'Levantamento topográfico') -> 'files') = 0,
  'Envio anterior vai para o histórico');
select tst.throws(format('select public.document_file_remove(%L)', tst.file_of('Levantamento topográfico')), 'Histórico não é apagado');
select tst.throws(format('select public.document_file_add(%L, %L, %L, null, null, null, %L)', (tst.doc('Matrícula do imóvel')).id, 'link', 'Outra', 'https://x.com/a'),
  'Documento aprovado não recebe novo arquivo');
select public.document_file_add((tst.doc('Levantamento topográfico')).id, 'link', 'Topográfico v2', null, null, null, 'https://drive.google.com/t2');
select tst.ok(tst.open_waits() = 0, 'Reenvio fecha o prazo de novo');
-- Cliente desiste de um arquivo antes da conferência
select public.document_file_add((tst.doc('Fotos do terreno')).id, 'link', 'Fotos', null, null, null, 'https://photos.google.com/a');
select public.document_file_remove(tst.file_of('Fotos do terreno'));
select tst.ok((tst.doc('Fotos do terreno')).status = 'pending', 'Sem arquivos, o documento volta a pendente');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.document_review((tst.doc('Levantamento topográfico')).id, true, null);
select tst.ok((public.project_documents(tst.pid()) -> 'progress' ->> 'percent')::int = 67, 'Dois de três aprovados: 67%');
reset role;

-- Liderança pede documento extra (exigência de órgão) e remove o que não faz sentido
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.document_extra_add(%L, %L, null, true)', tst.pid(), 'Certidão'), 'Colaborador não pede documento extra');
reset role;
select tst.login('lid@hq'); set role authenticated;
create temp table ex as select public.document_extra_add(tst.pid(), 'Certidão negativa de débitos', 'Exigida pela prefeitura', true) id;
grant select on ex to authenticated;
reset role;
select tst.ok(tst.notes('cli@x', 'document_requested') = 1 and tst.open_waits() = 1, 'Extra obrigatório: cliente avisado e prazo aberto');
select tst.ok((select string_agg(x ->> 'name', ' > ') from jsonb_array_elements(private.project_documents(tst.pid()) -> 'items') x)
  = 'Levantamento topográfico > Matrícula do imóvel > Fotos do terreno > Certidão negativa de débitos', 'Extras ficam no fim da lista');
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.document_remove(%L, null)', (select id from ex)), 'Remoção exige motivo');
select public.document_remove((select id from ex), 'Prefeitura dispensou');
select public.document_remove((tst.doc('Fotos do terreno')).id, 'Visita técnica já fotografou');
select tst.ok(jsonb_array_length(public.project_documents(tst.pid()) -> 'removed') = 2, 'Equipe vê os removidos');
reset role;
select tst.ok(tst.open_waits() = 0 and (tst.wait()).close_source = 'team', 'Sem obrigatório pendente, prazo fecha');
select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(public.project_documents(tst.pid()) -> 'items') = 2 and (public.project_documents(tst.pid()) -> 'progress' ->> 'percent')::int = 100,
  'Cliente não vê os removidos; 100% aprovado');
select tst.ok(public.document_projects() -> 0 -> 'progress' ->> 'percent' = '100', 'Lista de projetos do cliente com o progresso');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.document_restore((select id from ex));
select public.document_extra_update((select id from ex), 'Certidão negativa de débitos municipais', null, false);
select tst.throws(format('select public.document_extra_update(%L, %L, null, true)', (tst.doc('Matrícula do imóvel')).id, 'Matrícula'), 'Documento padrão não é editado no projeto');
reset role;
select tst.ok(tst.open_waits() = 0 and (tst.doc('Certidão negativa de débitos municipais')).removed_at is null, 'Extra devolvido como opcional não abre prazo');

-- Lista padrão muda: projetos acompanham
select tst.login('ga@hq'); set role authenticated;
select public.document_type_delete((select mat from ty));
select public.document_type_save(null, 'ART do levantamento', null, true, array['projeto_estrutural']);
select public.document_type_save((select topo from ty), 'Levantamento planialtimétrico', null, true, array['projeto_arquitetonico']);
reset role;
select tst.ok((tst.doc('Matrícula do imóvel')).removed_at is null, 'Documento excluído da lista continua onde já foi enviado');
select tst.ok((tst.doc('Levantamento planialtimétrico')).status = 'approved', 'Renomear na lista padrão atualiza o projeto');
select tst.ok((tst.doc('ART do levantamento')).id is not null and tst.open_waits() = 1, 'Novo obrigatório entra no projeto e abre o prazo');

-- Prazo dos documentos configurável por unidade
select tst.login('adm@hq'); set role authenticated;
select public.client_wait_settings_save('00000000-0000-4000-8000-000000000001', true, 2, 10);
select tst.ok((public.client_wait_settings_get('00000000-0000-4000-8000-000000000001') ->> 'documents_days')::int = 10, 'Prazo dos documentos da unidade: 10 dias úteis');
select tst.throws($$select public.client_wait_settings_save('00000000-0000-4000-8000-000000000001', true, 2, 40)$$, 'Prazo dos documentos limitado a 30 dias');
reset role;
