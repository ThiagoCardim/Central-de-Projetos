-- Entregas do projeto: apresentação, rodadas de revisão, aprovação, projeto final,
-- revisão adicional e indicador de revisões por responsável.
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

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "7701", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Iris", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;

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
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Iris Cliente' from public.projects p where p.external_id = '7701';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '7701' $$;
create function tst.ps(p_code text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id where ps.project_id = tst.pid() and s.code = p_code $$;
create function tst.item(p_code text) returns jsonb language sql as $$
  select i from jsonb_array_elements(public.project_deliveries(tst.pid()) -> 'items') i where (i ->> 'project_service_id')::uuid = tst.ps(p_code) $$;
create function tst.draft(p_code text) returns uuid language sql security definer as $$
  select v.id from public.delivery_versions v join public.project_deliveries d on d.id = v.delivery_id
  where d.project_service_id = tst.ps(p_code) and v.published_at is null and v.archived_at is null $$;
-- Publica uma versão com um link (como a equipe faria)
create function tst.publish(p_code text, p_kind text) returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.delivery_version_start(tst.pid(), tst.ps(p_code), p_kind, null, 'Segue a versão', null);
  perform public.delivery_file_add(v, 'link', 'Pranchas', null, null, null, 'https://drive.google.com/x/' || v);
  perform public.delivery_version_publish(v);
  return v;
end $$;
create function tst.notes(p_email text, p_kind text) returns int language sql security definer as $$
  select count(*)::int from public.notifications where recipient_profile_id = tst.uid(p_email) and kind = p_kind $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
-- A colaboradora é a responsável pelo Estudo Preliminar
select public.set_task_responsible(pt.id, tst.uid('col@hq'))
  from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
 where tr.project_service_id = tst.ps('projeto_arquitetonico') and pt.code = 'estudo_preliminar';
reset role;

-- Quadro de entregas
select tst.login('lid@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.project_deliveries(tst.pid()) -> 'items') = 2, 'Uma área de entregas por serviço contratado');
select tst.ok((tst.item('projeto_arquitetonico') ->> 'revisions_enabled')::boolean and (tst.item('projeto_arquitetonico') ->> 'included')::int = 3
  and tst.item('projeto_arquitetonico') ->> 'status' = 'in_production', 'Arquitetônico: 3 revisões incluídas, em produção');
select tst.ok(tst.item('projeto_arquitetonico') -> 'creation_responsible' ->> 'name' = 'Colab Arquiteta', 'Responsável pela criação vem do cronograma');
reset role;

-- Quem publica
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.delivery_version_start(%L, %L, %L, null, null, null)', tst.pid(), tst.ps('projeto_arquitetonico'), 'presentation'),
  'Quem não está no projeto não publica');
reset role;
select tst.login('cs@hq'); set role authenticated;
select tst.throws(format('select public.delivery_version_start(%L, %L, %L, null, null, null)', tst.pid(), tst.ps('projeto_arquitetonico'), 'presentation'),
  'CS não publica entregas');
reset role;

select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.delivery_version_start(%L, %L, %L, null, null, null)', tst.pid(), tst.ps('projeto_arquitetonico'), 'final'),
  'Projeto final só depois da aprovação da criação');
create temp table v0 as select public.delivery_version_start(tst.pid(), tst.ps('projeto_arquitetonico'), 'presentation', null, 'Primeira proposta', null) id;
grant select on v0 to authenticated;
select tst.throws(format('select public.delivery_version_start(%L, %L, %L, null, null, null)', tst.pid(), tst.ps('projeto_arquitetonico'), 'presentation'),
  'Uma versão em preparação por vez');
select tst.throws(format('select public.delivery_version_publish(%L)', (select id from v0)), 'Não publica sem arquivo');
select tst.throws(format('select public.delivery_file_add(%L, %L, %L, null, null, null, %L)', (select id from v0), 'link', 'X', 'drive.google.com/abc'), 'Link precisa ser completo');
select tst.throws(format('select public.delivery_file_add(%L, %L, %L, %L, %L, 10, null)', (select id from v0), 'file', 'a.pdf', 'outro/caminho/a.pdf', 'application/pdf'), 'Arquivo fora da pasta da versão');
select public.delivery_file_add((select id from v0), 'file', 'Pranchas.pdf', tst.pid() || '/' || (select id from v0) || '/a.pdf', 'application/pdf', 1024, null);
select public.delivery_file_add((select id from v0), 'link', 'Vídeo 3D', null, null, null, 'https://drive.google.com/file/d/abc');
select tst.ok(private.delivery_file_writable(tst.pid()::text, (select id::text from v0)), 'Equipe pode subir arquivo na versão em preparação');
select tst.ok(tst.item('projeto_arquitetonico') -> 'creation_responsible' ->> 'name' = 'Colab Arquiteta'
  and (select v -> 'responsible' ->> 'name' from jsonb_array_elements(tst.item('projeto_arquitetonico') -> 'versions') v limit 1) = 'Colab Arquiteta',
  'Versão atribuída à responsável pela criação');
reset role;

select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(tst.item('projeto_arquitetonico') -> 'versions') = 0, 'Cliente não vê versão em preparação');
select tst.ok(not private.delivery_file_readable(tst.pid()::text, (select id::text from v0)), 'Cliente não baixa arquivo de rascunho');
select tst.ok(not private.delivery_file_writable(tst.pid()::text, (select id::text from v0)), 'Cliente não sobe arquivo');
reset role;

select tst.login('col@hq'); set role authenticated;
select public.delivery_version_publish((select id from v0));
select tst.throws(format('select public.delivery_file_add(%L, %L, %L, null, null, null, %L)', (select id from v0), 'link', 'X', 'https://a.com'), 'Versão publicada não muda');
reset role;
select tst.ok(tst.notes('cli@x', 'delivery_published') = 1, 'Cliente avisado da apresentação');

-- Cliente pede revisões
select tst.login('cli@x'); set role authenticated;
select tst.ok(tst.item('projeto_arquitetonico') ->> 'status' = 'awaiting_client' and jsonb_array_length(tst.item('projeto_arquitetonico') -> 'versions') = 1,
  'Cliente vê a apresentação e a entrega aguarda ele');
select tst.ok(private.delivery_file_readable(tst.pid()::text, (select id::text from v0)), 'Cliente baixa arquivo publicado');
select tst.ok((tst.item('projeto_arquitetonico') -> 'versions' -> 0 -> 'responsible') = 'null'::jsonb, 'Cliente não vê o responsável interno');
select tst.throws(format('select public.delivery_request_revision(%L, %L, %L, null)', tst.pid(), tst.ps('projeto_arquitetonico'), '{"  "}'), 'Revisão precisa de ao menos uma alteração');
select tst.ok(public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Aumentar a suíte', 'Trocar o revestimento da fachada'], 'Obrigada!') = 1,
  'Revisão 1 solicitada com duas alterações');
select tst.throws(format('select public.delivery_request_revision(%L, %L, %L, null)', tst.pid(), tst.ps('projeto_arquitetonico'), '{"Mais uma"}'), 'Não abre outra revisão com uma em andamento');
select tst.throws(format('select public.delivery_approve(%L, %L, null)', tst.pid(), tst.ps('projeto_arquitetonico')), 'Não aprova com revisão em andamento');
select tst.ok(tst.item('projeto_arquitetonico') ->> 'status' = 'revision_requested' and (tst.item('projeto_arquitetonico') ->> 'used')::int = 1, 'Revisão em andamento: 1 de 3 usada');
reset role;
select tst.ok(tst.notes('col@hq', 'delivery_revision') = 1 and tst.notes('lid@hq', 'delivery_revision') = 1, 'Responsável e líder da área avisados');
select tst.ok((select responsible_id from public.delivery_revision_requests where round = 1) = tst.uid('col@hq'), 'Revisão 1 conta para a responsável');

select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.delivery_version_start(%L, %L, %L, null, null, null)', tst.pid(), tst.ps('projeto_arquitetonico'), 'presentation'), 'Apresentação não se repete');
select tst.publish('projeto_arquitetonico', 'revision');
select tst.ok(tst.item('projeto_arquitetonico') ->> 'status' = 'awaiting_client'
  and (select v ->> 'title' from jsonb_array_elements(tst.item('projeto_arquitetonico') -> 'versions') v limit 1) = 'Revisão 1', 'Revisão 1 entregue');
reset role;
select tst.ok((select answered_at is not null from public.delivery_revision_requests where round = 1), 'Pedido da revisão 1 respondido');

-- Rodadas 2 e 3
select tst.login('cli@x'); set role authenticated;
select public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Ajuste 2'], null);
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'revision');
reset role;
select tst.login('cli@x'); set role authenticated;
select public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Ajuste 3'], null);
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'revision');
reset role;
select tst.login('cli@x'); set role authenticated;
select tst.ok((tst.item('projeto_arquitetonico') ->> 'used')::int = 3 and (tst.item('projeto_arquitetonico') ->> 'allowed')::int = 3, '3 de 3 revisões usadas');
select tst.throws(format('select public.delivery_request_revision(%L, %L, %L, null)', tst.pid(), tst.ps('projeto_arquitetonico'), '{"Quarta"}'), 'Limite de revisões incluídas');
reset role;

-- Revisão adicional: colaboradora pede, líder da área libera
select tst.login('col@hq'); set role authenticated;
create temp table x1 as select public.delivery_extra_request(tst.pid(), tst.ps('projeto_arquitetonico'), 'courtesy', 'Cliente pediu ajuste pequeno na cozinha', null) id;
grant select on x1 to authenticated;
select tst.throws(format('select public.delivery_extra_request(%L, %L, %L, %L, null)', tst.pid(), tst.ps('projeto_arquitetonico'), 'paid', 'Outro pedido'), 'Um pedido pendente por vez');
select tst.throws(format('select public.delivery_extra_decide(%L, true, null)', (select id from x1)), 'Colaboradora não libera');
reset role;
select tst.ok(tst.notes('lid@hq', 'delivery_extra') = 1, 'Líder da área avisado do pedido');
select tst.login('eng@hq'); set role authenticated;
select tst.throws(format('select public.delivery_extra_decide(%L, true, null)', (select id from x1)), 'Líder de outra área não libera');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.delivery_extra_decide((select id from x1), true, 'Ok, cortesia');
select tst.ok((tst.item('projeto_arquitetonico') ->> 'allowed')::int = 4, 'Cortesia aprovada: 4 rodadas');
reset role;

select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(tst.item('projeto_arquitetonico') -> 'extras') = 1
  and tst.item('projeto_arquitetonico') -> 'extras' -> 0 -> 'reason' = 'null'::jsonb, 'Cliente vê a revisão extra liberada, sem o motivo interno');
select public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Cozinha'], null);
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'revision');
reset role;

-- Aprovação e projeto final
select tst.login('cli@x'); set role authenticated;
select public.delivery_approve(tst.pid(), tst.ps('projeto_arquitetonico'), 'Perfeito!');
select tst.ok(tst.item('projeto_arquitetonico') ->> 'status' = 'detailing' and tst.item('projeto_arquitetonico') ->> 'creation_approved_by' = 'Iris Cliente',
  'Criação aprovada pelo cliente: segue para detalhamento');
select tst.throws(format('select public.delivery_request_revision(%L, %L, %L, null)', tst.pid(), tst.ps('projeto_arquitetonico'), '{"Depois"}'), 'Depois de aprovado, não pede revisão');
reset role;
select tst.ok(tst.notes('col@hq', 'delivery_approved') = 1, 'Responsável avisada da aprovação');

select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'final');
select tst.ok(tst.item('projeto_arquitetonico') ->> 'status' = 'final' and tst.item('projeto_arquitetonico') ->> 'last_final_version_id' is not null, 'Projeto final publicado');
reset role;

-- Revisão adicional paga liberada direto pelo líder reabre a criação
select tst.login('lid@hq'); set role authenticated;
select public.delivery_extra_request(tst.pid(), tst.ps('projeto_arquitetonico'), 'paid', 'Cliente contratou revisão adicional', 450);
select tst.ok(tst.item('projeto_arquitetonico') ->> 'status' = 'awaiting_client' and (tst.item('projeto_arquitetonico') ->> 'allowed')::int = 5,
  'Revisão paga liberada pelo líder: criação reaberta, 5 rodadas');
reset role;
select tst.ok(tst.notes('cli@x', 'delivery_extra_released') = 2, 'Cliente avisado das revisões extras');

-- Equipe registra a revisão em nome do cliente
select tst.login('col@hq'); set role authenticated;
select tst.ok(public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Pedido por WhatsApp: trocar a janela'], null) = 5, 'Equipe registra a revisão 5 em nome do cliente');
select tst.ok((tst.item('projeto_arquitetonico') -> 'open_request' ->> 'on_behalf')::boolean, 'Fica marcado que a equipe registrou');
reset role;

-- Documentos do projeto
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.delivery_version_start(%L, null, %L, null, null, null)', tst.pid(), 'presentation'), 'Documentos do projeto não têm revisão');
select public.delivery_version_start(tst.pid(), null, 'document', 'Matrícula e IPTU', null, null);
reset role;

-- Indicador de revisões
select tst.login('lid@hq'); set role authenticated;
create temp table ov as select public.revisions_overview(null, null) j;
select tst.ok((select (p ->> 'revisions')::int from ov, jsonb_array_elements(j -> 'people') p where p ->> 'name' = 'Colab Arquiteta') = 5
  and (select (p ->> 'presentations')::int from ov, jsonb_array_elements(j -> 'people') p where p ->> 'name' = 'Colab Arquiteta') = 1
  and (select (p ->> 'courtesy')::int + (p ->> 'paid')::int from ov, jsonb_array_elements(j -> 'people') p where p ->> 'name' = 'Colab Arquiteta') = 2,
  'Liderança vê 5 revisões, 1 apresentação e 2 extras da colaboradora');
select tst.ok(jsonb_array_length(public.revisions_person(tst.uid('col@hq'), null)) = 5, 'Detalhe das revisões da pessoa');
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.ok((select j ->> 'scope' from (select public.revisions_overview(null, null) j) x) = 'self', 'Colaboradora vê o próprio indicador');
reset role;
select tst.login('cli@x'); set role authenticated;
select tst.throws('select public.revisions_overview(null, null)', 'Cliente não vê o indicador');
reset role;

-- Regras por serviço
select tst.login('adm@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.delivery_settings_list() -> 'services') > 10, 'ADM vê as regras por serviço');
select tst.throws(format('select public.delivery_settings_save(%L, true, 2, null)', (select service_id from public.project_services where id = tst.ps('projeto_estrutural'))),
  'Só o ADM Global altera as regras');
reset role;
select tst.login('ga@hq'); set role authenticated;
select public.delivery_settings_save((select service_id from public.project_services where id = tst.ps('projeto_estrutural')), true, 2, array['producao_disciplina']);
select tst.ok((tst.item('projeto_estrutural') ->> 'included')::int = 2, 'Nova regra vale para entregas ainda não iniciadas');
reset role;

select tst.login('cli@x'); set role authenticated;
select tst.ok((select (p ->> 'awaiting_client')::int from jsonb_array_elements(public.delivery_projects()) p) = 0
  and (select (p ->> 'published')::int from jsonb_array_elements(public.delivery_projects()) p) = 6, 'Resumo das entregas para o cliente');
reset role;
