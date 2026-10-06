-- Testes da Etapa 3: geração do cronograma, escolha de template, dependências
-- entre serviços, dias úteis, prévia de impacto, reprogramação com motivo,
-- status, responsável, serviço adicional, área e gerenciador de templates.
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
-- Etapa de um projeto por código de serviço e código da etapa
create function tst.task(p_ext text, p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  join public.project_services ps on ps.id = tr.project_service_id
  join public.services s on s.id = ps.service_id
  join public.projects p on p.id = t.project_id
  where p.external_id = p_ext and s.code = p_service and t.code = p_code
$$;
create function tst.pid(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','arq@hq','eng@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', null),
       ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Engenheiro', 'eng@hq', 'collaborator', 'pj');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

-- -----------------------------------------------------------------------------
-- Dias úteis
-- -----------------------------------------------------------------------------
select tst.ok(public.next_business_day('2026-10-10') = '2026-10-12', 'Sábado avança para segunda');
select tst.ok(public.add_business_days('2026-10-05', 5) = '2026-10-09', '5 dias úteis a partir de segunda terminam na sexta');
select tst.ok(public.add_business_days('2026-10-09', 2) = '2026-10-12', 'Prazo atravessa o fim de semana');
insert into public.holidays (calendar_id, date, name) values ('00000000-0000-4000-8000-000000000101', '2026-10-12', 'Nossa Senhora Aparecida');
select tst.ok(public.add_business_days('2026-10-09', 2, '00000000-0000-4000-8000-000000000101') = '2026-10-13', 'Feriado do calendário é pulado');

-- -----------------------------------------------------------------------------
-- Projeto: Arquitetura + Complementares + Interiores (180 m²)
-- -----------------------------------------------------------------------------
set role service_role;
select public.ingest_crm_webhook('pipefy', '{
  "card_id": "2001", "cliente": {"nome": "Ana Prado", "email": "ana@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Prado", "area_m2": "180"},
  "servicos": "Projeto Arquitetônico, Projetos Complementares, Design de Interiores",
  "data_fechamento": "01/10/2026"}'::jsonb);
-- Projeto só de Engenharia, sem área: Elétrico + Interiores
select public.ingest_crm_webhook('pipefy', '{
  "card_id": "2002", "cliente": {"nome": "Bruno Lima", "email": "bruno@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Apto Lima"},
  "servicos": "Projeto Elétrico, Design de Interiores",
  "data_fechamento": "02/10/2026"}'::jsonb);
reset role;

select tst.ok(not exists (select 1 from public.project_schedule_tracks where project_id = tst.pid('2001')),
  'Antes da equipe confirmada não há cronograma');

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid('2001'), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', (select id from public.profiles where email = 'lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', (select id from public.profiles where email = 'arq@hq'))));
select public.assign_project_team(tst.pid('2002'), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', (select id from public.profiles where email = 'lid@hq'))));
reset role; select tst.login('');

-- Geração
select tst.ok((select count(*) from public.project_schedule_tracks where project_id = tst.pid('2001')) = 4,
  'Confirmar equipe gera uma trilha por serviço contratado');
select tst.ok((select count(*) from public.project_schedule_tracks where project_id = tst.pid('2001') and status = 'planned') = 4,
  'Todas as trilhas têm template (área 180 m² escolhe Interiores até 500 m²)');
select tst.ok((select count(*) from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
               join public.schedule_templates st on st.id = tr.template_id
               where t.project_id = tst.pid('2001') and st.name like 'Design de Interiores — até%') = 7, 'Interiores até 500 m² com 7 etapas');
select tst.ok((select count(*) from public.project_tasks t
               join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
               join public.project_services ps on ps.id = tr.project_service_id
               join public.services s on s.id = ps.service_id
               where t.project_id = tst.pid('2001') and s.code = 'projeto_arquitetonico') = 5, 'Arquitetura com 5 etapas');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).status = 'ready', 'Primeira etapa fica pronta para iniciar');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).status = 'not_started', 'Etapa seguinte aguarda');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).planned_start_date = public.next_business_day(current_date, '00000000-0000-4000-8000-000000000101'),
  'Cronograma começa no próximo dia útil');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).planned_end_date =
              public.add_business_days((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).planned_start_date, 20, '00000000-0000-4000-8000-000000000101'),
  'Planejamento dura 20 dias úteis');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).planned_start_date =
              public.next_business_day((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).planned_end_date + 1, '00000000-0000-4000-8000-000000000101'),
  'Etapa seguinte começa no dia útil após o término da anterior');

-- Engenharia: dependência da Arquitetura e etapas condicionais
select tst.ok((tst.task('2001', 'projeto_eletrico', 'producao_arquitetura')).planned_end_date =
              (tst.task('2001', 'projeto_arquitetonico', 'estudo_preliminar')).planned_end_date,
  'Tempo de produção da Arquitetura termina com o Estudo Preliminar');
select tst.ok((tst.task('2001', 'projeto_eletrico', 'orcamento_estimativo')).id is null, 'Orçamento Estimativo não contratado: etapa não entra');
select tst.ok(exists (select 1 from public.task_dependencies d
               where d.task_id = (tst.task('2001', 'projeto_eletrico', 'planejamento')).id
                 and d.depends_on_task_id = (tst.task('2001', 'projeto_eletrico', 'revisao_apr_arq_eng')).id),
  'Sequência atravessa a etapa condicional ausente');
select tst.ok((tst.task('2001', 'projeto_eletrico', 'compatibilizacao_interiores')).id is not null, 'Interiores contratado: compatibilização para interiores entra');
select tst.ok((tst.task('2001', 'projeto_eletrico', 'producao_disciplina')).planned_end_date is null,
  'Etapa sem prazo fornecido fica a definir (sem data inventada)');
select tst.ok((tst.task('2001', 'projeto_eletrico', 'compatibilizacao')).planned_start_date is null,
  'Etapas depois de um prazo a definir ficam sem data');
select tst.ok((select planned_end_date from public.project_schedule_tracks tr
               join public.project_services ps on ps.id = tr.project_service_id join public.services s on s.id = ps.service_id
               where tr.project_id = tst.pid('2001') and s.code = 'projeto_eletrico') is null,
  'Trilha com etapa a definir não mostra previsão falsa');

-- Projeto sem Arquitetura e sem área
select tst.ok((tst.task('2002', 'projeto_eletrico', 'producao_arquitetura')).status = 'cancelled'
              and (tst.task('2002', 'projeto_eletrico', 'producao_arquitetura')).auto_skipped,
  'Sem Arquitetura contratada: etapa dependente é dispensada');
select tst.ok((tst.task('2002', 'projeto_eletrico', 'revisao_apr_arq_eng')).planned_start_date =
              public.next_business_day((tst.task('2002', 'projeto_eletrico', 'briefing_arq_apr_eng')).planned_end_date + 1, '00000000-0000-4000-8000-000000000101'),
  'Etapa dispensada não segura a seguinte');
select tst.ok((select tr.status from public.project_schedule_tracks tr
               join public.project_services ps on ps.id = tr.project_service_id join public.services s on s.id = ps.service_id
               where tr.project_id = tst.pid('2002') and s.code = 'design_interiores') = 'awaiting_area',
  'Interiores sem área: aguardando área (não assume até 500 m²)');

select tst.login('arq@hq'); set role authenticated;
select tst.throws(format('select public.set_project_area(%L, 600)', tst.pid('2002')), 'Colaborador não define área');
reset role; select tst.login('');

select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.set_project_area(%L, 0)', tst.pid('2002')), 'Área precisa ser maior que zero');
select tst.ok((public.set_project_area(tst.pid('2002'), 600) ->> 'tasks_created')::int = 7, 'Informar a área gera a trilha de Interiores');
reset role; select tst.login('');
select tst.ok((tst.task('2002', 'design_interiores', 'layout_modelagem')).id is not null, '600 m² usa o template acima de 500 m²');

-- -----------------------------------------------------------------------------
-- Prévia e reprogramação
-- -----------------------------------------------------------------------------
select tst.login('lid@hq'); set role authenticated;
select (tst.task('2001', 'projeto_arquitetonico', 'alteracoes')).planned_end_date as alt_before,
       (tst.task('2001', 'projeto_eletrico', 'producao_arquitetura')).planned_end_date as eng_before \gset
select public.preview_task_change((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, null, 25) as pv \gset
select tst.ok((:'pv'::jsonb ->> 'impacted_count')::int >= 4, 'Prévia mostra quantas etapas serão impactadas');
select tst.ok(:'pv'::jsonb -> 'impacted' @> jsonb_build_array(jsonb_build_object('name', 'Tempo de Produção da Arquitetura')),
  'Prévia inclui impacto em outro serviço');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'alteracoes')).planned_end_date = :'alt_before'::date, 'Prévia não altera nada');
select tst.throws(format('select public.reschedule_task(%L, null, 25, %L)', (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, ''),
  'Alterar prazo exige motivo');
select tst.ok((public.reschedule_task((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, null, 25, 'Cliente pediu mais reuniões') ->> 'impacted_count')::int >= 4,
  'Reprogramação aplicada com motivo');
reset role; select tst.login('');

select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'alteracoes')).planned_end_date =
              public.add_business_days(:'alt_before'::date + 1, 5, '00000000-0000-4000-8000-000000000101'),
  'Etapas seguintes deslocadas em 5 dias úteis');
select tst.ok((tst.task('2001', 'projeto_eletrico', 'producao_arquitetura')).planned_end_date > :'eng_before'::date,
  'Dependência entre serviços recalculada');
select tst.ok((select reason from public.task_changes where change_type = 'duration' order by created_at desc limit 1) = 'Cliente pediu mais reuniões',
  'Histórico guarda o motivo');
select tst.ok((select cardinality(impacted_task_ids) from public.task_changes where change_type = 'duration' order by created_at desc limit 1) >= 4,
  'Histórico guarda as etapas impactadas');
select tst.ok((select (before ->> 'planned_duration_days')::int = 20 and (after ->> 'planned_duration_days')::int = 25
               from public.task_changes where change_type = 'duration' order by created_at desc limit 1), 'Histórico guarda antes e depois');

-- Reprogramar início ("não antes de")
select tst.login('lid@hq'); set role authenticated;
select public.reschedule_task((tst.task('2002', 'projeto_eletrico', 'briefing_arq_apr_eng')).id, current_date + 30, null, 'Cliente viajando');
reset role; select tst.login('');
select tst.ok((tst.task('2002', 'projeto_eletrico', 'briefing_arq_apr_eng')).planned_start_date =
              public.next_business_day(current_date + 30, '00000000-0000-4000-8000-000000000101'), 'Nova data de início respeitada');

-- -----------------------------------------------------------------------------
-- Responsável e status
-- -----------------------------------------------------------------------------
select tst.login('arq@hq'); set role authenticated;
select tst.throws(format('select public.set_task_status(%L, %L)', (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, 'in_progress'),
  'Colaborador não altera etapa de outra pessoa');
reset role; select tst.login('');

select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.set_task_responsible(%L, %L)', (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id,
  (select id from public.profiles where email = 'ga@hq')), 'Responsável precisa ser da equipe da unidade executora');
select public.set_task_responsible((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, (select id from public.profiles where email = 'arq@hq'));
select public.set_task_responsible((tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).id, (select id from public.profiles where email = 'arq@hq'));
reset role; select tst.login('');
select tst.ok(exists (select 1 from public.notifications where kind = 'task_assigned'
               and recipient_profile_id = (select id from public.profiles where email = 'arq@hq')), 'Responsável recebe aviso');

select tst.login('arq@hq'); set role authenticated;
select tst.ok(public.set_task_status((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, 'in_progress') ->> 'status' = 'in_progress',
  'Responsável inicia a própria etapa');
select tst.throws(format('select public.set_task_status(%L, %L)', (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, 'waiting_client'),
  'Aguardando cliente exige motivo');
select tst.throws(format('select public.reschedule_task(%L, null, 30, %L)', (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, 'quero'),
  'Colaborador não reprograma prazo');
select tst.throws(format('update public.project_tasks set planned_duration_days = 2 where id = %L', (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id),
  'Colaborador não altera prazo direto na tabela');
select public.set_task_status((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, 'completed');
reset role; select tst.login('');

select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).actual_start_date = current_date, 'Início real registrado');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).actual_end_date = current_date, 'Término real registrado');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).status = 'ready', 'Concluir libera a etapa seguinte');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).planned_start_date =
              public.next_business_day(current_date + 1, '00000000-0000-4000-8000-000000000101'),
  'Conclusão antecipada puxa a etapa seguinte');
select tst.ok(exists (select 1 from public.notifications where kind = 'task_ready'), 'Responsável da etapa liberada recebe aviso');
select tst.ok((select tr.status from public.project_schedule_tracks tr
               join public.project_services ps on ps.id = tr.project_service_id join public.services s on s.id = ps.service_id
               where tr.project_id = tst.pid('2001') and s.code = 'projeto_arquitetonico') = 'in_progress', 'Trilha em andamento');

select tst.login('arq@hq'); set role authenticated;
select public.set_task_status((tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).id, 'waiting_client', 'Aguardando medidas do terreno');
reset role; select tst.login('');
select tst.ok((select is_waiting_client from public.task_alerts where task_id = (tst.task('2001', 'projeto_arquitetonico', 'envio_briefing')).id),
  'Alerta de aguardando cliente');

-- Dependência manual: sem ciclo
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.add_task_dependency(%L, %L, %L)',
  (tst.task('2001', 'projeto_arquitetonico', 'planejamento')).id, (tst.task('2001', 'projeto_arquitetonico', 'alteracoes')).id, 'teste'),
  'Dependência que cria ciclo é recusada');
select tst.ok((public.add_task_dependency((tst.task('2001', 'design_interiores', 'planejamento')).id,
  (tst.task('2001', 'projeto_arquitetonico', 'estudo_preliminar')).id, 'Interiores começa após o estudo') ->> 'impacted_count')::int >= 1,
  'Dependência manual entre serviços recalcula');
select tst.ok((public.remove_task_dependency((tst.task('2001', 'design_interiores', 'planejamento')).id,
  (tst.task('2001', 'projeto_arquitetonico', 'estudo_preliminar')).id, 'Combinado com cliente') ->> 'impacted_count')::int >= 1,
  'Remover dependência recalcula');
reset role; select tst.login('');

-- -----------------------------------------------------------------------------
-- Serviço adicional: entra sem reiniciar o cronograma
-- -----------------------------------------------------------------------------
select (tst.task('2001', 'projeto_arquitetonico', 'alteracoes')).planned_end_date as alt_now \gset
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "2003", "tipo": "servico_adicional", "projeto_referencia": "2001", "servicos": "Projeto Estrutural"}'::jsonb);
reset role;
select tst.ok((select count(*) from public.project_schedule_tracks where project_id = tst.pid('2001')) = 4, 'Serviço adicional aguarda revisão antes de entrar');
select tst.login('lid@hq'); set role authenticated;
select tst.ok((public.activate_project_service((select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
   where ps.project_id = tst.pid('2001') and s.code = 'projeto_estrutural')) ->> 'tracks_created')::int = 1, 'Ativar serviço cria nova trilha');
reset role; select tst.login('');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'alteracoes')).planned_end_date = :'alt_now'::date, 'Arquitetura preservada');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'planejamento')).status = 'completed', 'Etapas concluídas preservadas');
select tst.ok((tst.task('2001', 'projeto_estrutural', 'producao_arquitetura')).planned_end_date =
              (tst.task('2001', 'projeto_arquitetonico', 'estudo_preliminar')).planned_end_date, 'Nova trilha respeita dependência da Arquitetura');

-- -----------------------------------------------------------------------------
-- Gerenciador de templates
-- -----------------------------------------------------------------------------
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.create_template_draft(%L)', (select id from public.services where code = 'projeto_arquitetonico')),
  'Líder não altera o padrão YouCon');
reset role; select tst.login('');

select tst.login('ga@hq'); set role authenticated;
select public.create_template_draft(null, (select id from public.schedule_templates where name = 'Projeto Arquitetônico' and active)) as draft \gset
select tst.ok((select version from public.schedule_templates where id = :'draft') = 2, 'Nova versão criada como rascunho v2');
select tst.ok((select count(*) from public.template_tasks where template_id = :'draft') = 5, 'Rascunho copia as etapas');
select tst.throws(format('select public.create_template_draft(null, %L)', (select id from public.schedule_templates where name = 'Projeto Arquitetônico' and active)),
  'Só um rascunho por variante');
select tst.throws(format($$update public.template_tasks set default_duration_days = 99 where template_id = %L$$,
  (select id from public.schedule_templates where name = 'Projeto Arquitetônico' and active)), 'Versão publicada é imutável');
select tst.throws(format($$select public.save_template_draft(%L, null, '[{"name":"Produção","duration_type":"dependent"}]')$$, :'draft'),
  'Etapa dependente precisa apontar a etapa de outro serviço');
select public.save_template_draft(:'draft', 'Projeto Arquitetônico', jsonb_build_array(
  jsonb_build_object('id', (select id from public.template_tasks where template_id = :'draft' and code = 'planejamento'), 'name', 'Planejamento', 'duration_days', 15),
  jsonb_build_object('name', 'Levantamento no local', 'duration_days', 3),
  jsonb_build_object('id', (select id from public.template_tasks where template_id = :'draft' and code = 'envio_briefing'), 'name', 'Envio do Briefing', 'duration_days', 7),
  jsonb_build_object('id', (select id from public.template_tasks where template_id = :'draft' and code = 'estudo_preliminar'), 'name', 'Estudo Preliminar', 'duration_days', 20),
  jsonb_build_object('id', (select id from public.template_tasks where template_id = :'draft' and code = 'alteracoes'), 'name', 'Alterações', 'duration_days', 30)
));
select tst.ok((select count(*) from public.template_tasks where template_id = :'draft') = 5, 'Rascunho salvo (uma etapa removida, uma incluída)');
select tst.ok((select code from public.template_tasks where template_id = :'draft' and name = 'Levantamento no local') = 'levantamento_no_local', 'Código gerado a partir do nome');
select tst.ok((select count(*) from public.template_task_dependencies d join public.template_tasks t on t.id = d.template_task_id where t.template_id = :'draft') = 4,
  'Sequência refeita');
select public.publish_template(:'draft', 'Inclui levantamento no local');
reset role; select tst.login('');

select tst.ok((select active from public.schedule_templates where id = :'draft'), 'Nova versão vigente');
select tst.ok((select count(*) from public.schedule_templates st join public.services s on s.id = st.service_id
               where s.code = 'projeto_arquitetonico' and st.active) = 1, 'Uma versão vigente por variante');
select tst.ok((select status from public.schedule_templates where name = 'Projeto Arquitetônico' and version = 1) = 'archived', 'Versão anterior arquivada');
select tst.ok((select st.version from public.project_schedule_tracks tr join public.schedule_templates st on st.id = tr.template_id
               join public.project_services ps on ps.id = tr.project_service_id join public.services s on s.id = ps.service_id
               where tr.project_id = tst.pid('2001') and s.code = 'projeto_arquitetonico') = 1, 'Projeto já iniciado continua com a versão anterior');
select tst.ok((tst.task('2001', 'projeto_arquitetonico', 'imagens_3d_video')).id is not null, 'Etapas do projeto não mudam com a nova versão');

-- Variante com faixa sobreposta é recusada
select tst.login('ga@hq'); set role authenticated;
select public.create_template_draft((select id from public.services where code = 'design_interiores'), null, null, 400, 800, 'Interiores médio') as d2 \gset
select public.save_template_draft(:'d2', null, '[{"name":"Planejamento","duration_days":10}]');
select tst.throws(format('select public.publish_template(%L)', :'d2'), 'Faixas de área sobrepostas são recusadas');
select public.discard_template_draft(:'d2');
reset role; select tst.login('');
select tst.ok(not exists (select 1 from public.schedule_templates where id = :'d2'), 'Rascunho descartado');

\echo '✔ Etapa 3 — motor de cronograma'
