-- Equipe por serviço, colaborador indireto, biblioteca de etapas, etapa extra e foto.
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
create function tst.ps(p_service text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
  join public.projects p on p.id = ps.project_id where p.external_id = '4001' and s.code = p_service $$;
create or replace function tst.task(p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  where tr.project_service_id = tst.ps(p_service) and t.code = p_code $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','arq@hq','est@hq','comp@hq','r3d@hq','out@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', null),
       ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Eng. Estrutural', 'est@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Eng. Complementares', 'comp@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Renderista', 'r3d@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Outra pessoa', 'out@hq', 'collaborator', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;



set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "6001", "cliente": {"nome": "Dora", "email": "dora@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Dora", "area_m2": "200"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '6001' $$;
create or replace function tst.ps(p_service text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
  join public.projects p on p.id = ps.project_id where p.external_id = '6001' and s.code = p_service $$;

create function tst.col(p_name text) returns uuid language sql as $$
  select id from public.project_board_columns where name = p_name and active and tenant_id = '00000000-0000-4000-8000-000000000001' $$;
create function tst.card() returns uuid language sql as $$ select column_id from public.project_board_cards where project_id = tst.pid() $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.board_ensure();
select public.board_add_column('Produção');
select public.board_add_column('Revisão com cliente');
-- Colaborador não configura
reset role; select tst.login('');
select tst.login('arq@hq'); set role authenticated;
select tst.throws($$select public.automation_save(null, '{"name":"x","trigger":"task_completed","actions":[{"type":"notify","recipients":["project_lead"],"title":"t"}]}'::jsonb)$$,
  'Colaborador não cria automação');
reset role; select tst.login('');

select tst.login('lid@hq'); set role authenticated;
select tst.throws($$select public.automation_save(null, '{"name":"x","trigger":"task_completed","actions":[]}'::jsonb)$$, 'Automação sem ação é recusada');
select tst.throws($$select public.automation_save(null, '{"name":"x","trigger":"qualquer","actions":[{"type":"notify","recipients":["project_lead"],"title":"t"}]}'::jsonb)$$, 'Gatilho inválido é recusado');

-- 1. Equipe definida (status do projeto) → card para "Produção"
select public.automation_save(null, jsonb_build_object('name', 'Projeto iniciado vai para Produção', 'trigger', 'project_status_changed',
  'conditions', jsonb_build_object('to_status', jsonb_build_array('in_progress')),
  'actions', jsonb_build_array(jsonb_build_object('type', 'move_card', 'column_id', tst.col('Produção')))));
-- 2. Planejamento do Arquitetônico concluído → aviso ao líder + card para "Revisão com cliente"
select public.automation_save(null, jsonb_build_object('name', 'Planejamento concluído', 'trigger', 'task_completed',
  'conditions', jsonb_build_object('steps', jsonb_build_array('planejamento'), 'services', jsonb_build_array('projeto_arquitetonico')),
  'actions', jsonb_build_array(
     jsonb_build_object('type', 'notify', 'recipients', jsonb_build_array('project_lead'), 'title', '{etapa} concluída', 'message', '{projeto} · {servico}'),
     jsonb_build_object('type', 'move_card', 'column_id', tst.col('Revisão com cliente')))));
-- 3. Estudo Preliminar iniciado → Imagens 3D para a renderista
select public.automation_save(null, jsonb_build_object('name', 'Renderista nas imagens', 'trigger', 'task_started',
  'conditions', jsonb_build_object('steps', jsonb_build_array('estudo preliminar')),
  'actions', jsonb_build_array(jsonb_build_object('type', 'set_task_responsible', 'step', 'Imagens 3D e Vídeo', 'assignee', 'user:' || tst.uid('r3d@hq')))));
-- 4. Laço: Produção ⇄ Revisão (deve parar sozinho)
select public.automation_save(null, jsonb_build_object('name', 'Laço A', 'trigger', 'card_moved',
  'conditions', jsonb_build_object('columns', jsonb_build_array(tst.col('Em andamento'))),
  'actions', jsonb_build_array(jsonb_build_object('type', 'move_card', 'column_id', tst.col('Encerrados')))));
select public.automation_save(null, jsonb_build_object('name', 'Laço B', 'trigger', 'card_moved',
  'conditions', jsonb_build_object('columns', jsonb_build_array(tst.col('Encerrados'))),
  'actions', jsonb_build_array(jsonb_build_object('type', 'move_card', 'column_id', tst.col('Em andamento')))));

select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('arq@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_estrutural'), 'user_id', tst.uid('est@hq'))));
reset role; select tst.login('');
select tst.ok(tst.card() = tst.col('Produção'), 'Projeto iniciado foi para "Produção" automaticamente');

create or replace function tst.task(p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  where tr.project_service_id = tst.ps(p_service) and t.code = p_code $$;
grant execute on function tst.task(text, text) to authenticated;

-- Planejamento do Estrutural concluído: condição de serviço não bate
select tst.login('lid@hq'); set role authenticated;
select public.set_task_status((tst.task('projeto_estrutural', 'briefing_arq_apr_eng')).id, 'in_progress');
select public.set_task_status((tst.task('projeto_estrutural', 'briefing_arq_apr_eng')).id, 'completed');
reset role; select tst.login('');
select tst.ok(tst.card() = tst.col('Produção'), 'Etapa de outro serviço não dispara a regra');

select tst.login('lid@hq'); set role authenticated;
select public.set_task_status((tst.task('projeto_arquitetonico', 'planejamento')).id, 'in_progress');
select public.set_task_status((tst.task('projeto_arquitetonico', 'planejamento')).id, 'completed');
reset role; select tst.login('');
select tst.ok(tst.card() = tst.col('Revisão com cliente'), 'Planejamento concluído moveu o card');
select tst.ok(exists (select 1 from public.notifications where kind = 'automation' and recipient_profile_id = tst.uid('lid@hq')
  and title = 'Planejamento concluída' and body like 'Casa Dora · Projeto Arquitetônico'), 'Aviso ao líder com o texto preenchido');
select tst.ok((select count(*) from public.automation_runs where ok) >= 2, 'Execuções registradas no histórico');

-- Estudo preliminar iniciado → responsável das imagens
select set_config('youcon.schedule_engine', 'on', false);
update public.project_tasks set status = 'completed', actual_start_date = current_date, actual_end_date = current_date
 where id = (tst.task('projeto_arquitetonico', 'envio_briefing')).id;
select set_config('youcon.schedule_engine', '', false);
select tst.login('lid@hq'); set role authenticated;
select public.set_task_status((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'in_progress');
reset role; select tst.login('');
select tst.ok((tst.task('projeto_arquitetonico', 'imagens_3d_video')).responsible_user_id = tst.uid('r3d@hq'), 'Automação definiu o responsável das imagens');
select tst.ok(exists (select 1 from public.project_team where project_id = tst.pid() and user_id = tst.uid('r3d@hq') and active), 'Responsável entrou na equipe');

-- Laço é interrompido e a operação manual funciona
select tst.login('lid@hq'); set role authenticated;
select public.board_move_card(tst.pid(), tst.col('Em andamento'));
reset role; select tst.login('');
select tst.ok((select count(*) from public.automation_runs where event = 'card_moved') between 1 and 4, 'Laço de automações parou sozinho');

-- Ação com falha não quebra a operação original
select tst.login('lid@hq'); set role authenticated;
select public.automation_save(null, jsonb_build_object('name', 'Vai falhar', 'trigger', 'task_completed',
  'actions', jsonb_build_array(jsonb_build_object('type', 'move_card', 'column_id', tst.col('Produção')))));
select public.board_delete_column(tst.col('Produção'), tst.col('A iniciar'), 'Produção');
select public.set_task_status((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'completed');
reset role; select tst.login('');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).status = 'completed', 'Etapa concluída mesmo com automação falhando');
select tst.ok(exists (select 1 from public.automation_runs r join public.automation_rules a on a.id = r.rule_id where a.name = 'Vai falhar' and not r.ok),
  'Falha fica registrada no histórico');

-- Desativar e arquivar
select tst.login('lid@hq'); set role authenticated;
select public.automation_set_active((select id from public.automation_rules where name = 'Vai falhar'), false);
select public.automation_archive((select id from public.automation_rules where name = 'Laço A'));
select tst.ok((select count(*) from public.automation_rules where not archived) = 5, 'Arquivada sai da lista ativa (fica no histórico)');
reset role; select tst.login('');

-- Atraso: detectado uma única vez
select set_config('youcon.schedule_engine', 'on', false);
update public.project_tasks set planned_end_date = current_date - 3, planned_start_date = current_date - 10
 where id = (tst.task('projeto_estrutural', 'producao_arquitetura')).id;
select set_config('youcon.schedule_engine', '', false);
select tst.login('lid@hq'); set role authenticated;
select public.automation_save(null, jsonb_build_object('name', 'Atrasou', 'trigger', 'task_overdue',
  'actions', jsonb_build_array(jsonb_build_object('type', 'notify', 'recipients', jsonb_build_array('task_responsible', 'project_lead'), 'title', 'Atraso: {etapa}'))));
reset role; select tst.login('');
select tst.ok(private.automation_scan_overdue() >= 1, 'Verificação encontra a etapa atrasada');
select tst.ok(private.automation_scan_overdue() = 0, 'A mesma etapa não dispara de novo');
select tst.ok(exists (select 1 from public.notifications where title = 'Atraso: Tempo de Produção da Arquitetura'), 'Aviso de atraso enviado');

-- Isolamento: outra unidade não vê as regras
insert into public.tenants (id, name, type, slug, parent_tenant_id) values ('00000000-0000-4000-8000-0000000000f2', 'Franquia B', 'franquia', 'franquia-b', '00000000-0000-4000-8000-000000000001');
insert into auth.users (id, email) values (gen_random_uuid(), 'lidb@fr');
insert into public.profiles (tenant_id, name, email, role, employment_type) values ('00000000-0000-4000-8000-0000000000f2', 'Líder B', 'lidb@fr', 'leader', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
select tst.login('lidb@fr'); set role authenticated;
select tst.ok(not exists (select 1 from public.automation_rules), 'Franquia não vê automações da Franqueadora');
select tst.throws(format($$select public.automation_set_active(%L, false)$$, (select id from public.automation_rules where name = 'Atrasou' limit 1)),
  'Franquia não altera automação de outra unidade');
reset role; select tst.login('');
