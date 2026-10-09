-- Rodadas de revisão no cronograma, ligadas às Entregas.
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

-- Padrão do Projeto Arquitetônico: Estudo Preliminar é a apresentação ao cliente
alter table public.template_tasks disable trigger template_tasks_guard;
update public.template_tasks tt set review_cycle = true, review_days = 5, feedback_days = 2
  from public.schedule_templates st join public.services s on s.id = st.service_id
 where st.id = tt.template_id and st.active and s.code = 'projeto_arquitetonico' and tt.code = 'estudo_preliminar';
alter table public.template_tasks enable trigger template_tasks_guard;

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

create function tst.task(p_code text, p_task text) returns public.project_tasks language sql security definer as $$
  select pt.* from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
  where tr.project_service_id = tst.ps(p_code) and pt.code = p_task $$;
create function tst.st(p_task text) returns text language sql security definer as $$ select (tst.task('projeto_arquitetonico', p_task)).status::text $$;
create function tst.deps_on(p_task uuid) returns uuid[] language sql security definer as $$
  select array_agg(depends_on_task_id) from public.task_dependencies where task_id = p_task $$;
create function tst.open_waits(p_source text) returns int language sql security definer as $$
  select count(*)::int from public.client_waits where project_id = tst.pid() and source = p_source and closed_at is null $$;
grant execute on all functions in schema tst to authenticated;

-- Cronograma gerado com as rodadas
select tst.ok((select count(*) from public.project_tasks where cycle_parent_id = (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id) = 7,
  'Estudo Preliminar ganha feedback + 3 revisões com feedback (7 etapas)');
select tst.ok(string_agg(name, ' > ' order by sequence) = 'Planejamento > Envio do Briefing > Estudo Preliminar > Feedback do cliente · Estudo Preliminar > Revisão 1 > Feedback do cliente · Revisão 1 > Revisão 2 > Feedback do cliente · Revisão 2 > Revisão 3 > Feedback do cliente · Revisão 3 > Alterações > Imagens 3D e Vídeo',
  'Sequência do cronograma: ' || string_agg(name, ' > ' order by sequence))
  from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id where tr.project_service_id = tst.ps('projeto_arquitetonico');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar__rev2')).planned_duration_days = 5
  and (tst.task('projeto_arquitetonico', 'estudo_preliminar__fb2')).planned_duration_days = 2, 'Prazos do padrão: revisão 5, feedback 2 dias úteis');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar__rev1')).responsible_user_id = tst.uid('col@hq'), 'Revisão fica com a responsável pela apresentação');
select tst.ok(tst.deps_on((tst.task('projeto_arquitetonico', 'alteracoes')).id) = array[(tst.task('projeto_arquitetonico', 'estudo_preliminar__fb3')).id],
  'Alterações aguarda o último feedback');
select tst.ok(tst.deps_on((tst.task('projeto_arquitetonico', 'estudo_preliminar__rev1')).id) = array[(tst.task('projeto_arquitetonico', 'estudo_preliminar__fb0')).id],
  'Revisão 1 aguarda o feedback da apresentação');
select tst.ok((tst.task('projeto_estrutural', 'producao_arquitetura')).id is not null
  and tst.deps_on((tst.task('projeto_estrutural', 'producao_arquitetura')).id) @> array[(tst.task('projeto_arquitetonico', 'estudo_preliminar__fb3')).id]
  and not tst.deps_on((tst.task('projeto_estrutural', 'producao_arquitetura')).id) @> array[(tst.task('projeto_arquitetonico', 'estudo_preliminar')).id],
  'Engenharia aguarda o fim das rodadas da arquitetura');
select tst.ok((tst.task('projeto_arquitetonico', 'alteracoes')).planned_start_date > (tst.task('projeto_arquitetonico', 'estudo_preliminar__fb3')).planned_end_date,
  'Datas recalculadas com as rodadas');

-- Publicar a apresentação conclui a etapa e abre o feedback
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'presentation');
reset role;
select tst.ok(tst.st('estudo_preliminar') = 'completed' and tst.st('estudo_preliminar__fb0') = 'waiting_client', 'Apresentação concluída; feedback aguardando o cliente');
select tst.ok(tst.open_waits('task') = 1 and tst.open_waits('delivery') = 0, 'Prazo do cliente corre pela etapa de feedback (sem espera duplicada)');

-- Cliente pede a revisão 1
select tst.login('cli@x'); set role authenticated;
select public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Aumentar a suíte'], null);
reset role;
select tst.ok(tst.st('estudo_preliminar__fb0') = 'completed' and tst.st('estudo_preliminar__rev1') = 'in_progress', 'Pedido conclui o feedback e inicia a Revisão 1');
select tst.ok(tst.open_waits('task') = 0, 'Espera do cliente encerrada com o pedido');

-- Revisão 1 publicada
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'revision');
reset role;
select tst.ok(tst.st('estudo_preliminar__rev1') = 'completed' and tst.st('estudo_preliminar__fb1') = 'waiting_client', 'Revisão 1 concluída; feedback 1 aguardando o cliente');
select tst.ok(exists (select 1 from public.task_changes c where c.task_id = (tst.task('projeto_arquitetonico', 'estudo_preliminar__rev1')).id and c.change_type = 'status'),
  'Mudanças de status ficam no histórico');

-- Rodadas 2 e 3, depois uma adicional
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
select tst.login('lid@hq'); set role authenticated;
select public.delivery_extra_request(tst.pid(), tst.ps('projeto_arquitetonico'), 'paid', 'Cliente contratou revisão adicional', 450);
reset role;
select tst.login('cli@x'); set role authenticated;
select public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Cozinha'], null);
reset role;
select tst.ok(tst.st('estudo_preliminar__fb3') = 'completed' and tst.st('estudo_preliminar__rev4') = 'in_progress'
  and tst.st('estudo_preliminar__fb4') = 'not_started', 'Revisão adicional cria a rodada 4 no cronograma');
select tst.ok(tst.deps_on((tst.task('projeto_arquitetonico', 'alteracoes')).id) = array[(tst.task('projeto_arquitetonico', 'estudo_preliminar__fb4')).id],
  'Alterações passa a aguardar o feedback da rodada adicional');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar__rev4')).sequence < (tst.task('projeto_arquitetonico', 'alteracoes')).sequence
  and (tst.task('projeto_arquitetonico', 'estudo_preliminar__rev4')).planned_duration_days = 5, 'Rodada adicional antes de Alterações, com o prazo do padrão');
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'revision');
reset role;

-- Aprovação conclui o feedback em aberto
select tst.login('cli@x'); set role authenticated;
select public.delivery_approve(tst.pid(), tst.ps('projeto_arquitetonico'), 'Perfeito!');
reset role;
select tst.ok(tst.st('estudo_preliminar__fb4') = 'completed' and tst.open_waits('task') = 0, 'Aprovação conclui o feedback e encerra a espera');
select tst.ok((select count(*) from public.project_tasks where cycle_parent_id = (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id and status <> 'completed') = 0,
  'Todas as rodadas usadas ficam concluídas');
select tst.ok(tst.deps_on((tst.task('projeto_estrutural', 'producao_arquitetura')).id) @> array[(tst.task('projeto_arquitetonico', 'estudo_preliminar__fb4')).id],
  'Engenharia também passa a aguardar a rodada adicional');

-- Cliente que aprova cedo antecipa o projeto: rodadas não usadas são dispensadas
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "7702", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Iris 2", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create or replace function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '7702' $$;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Iris Cliente' from public.projects p where p.external_id = '7702'
on conflict do nothing;
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;
create temp table alt as select (tst.task('projeto_arquitetonico', 'alteracoes')).planned_start_date s;
select tst.login('lid@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'presentation');
reset role;
select tst.login('cli@x'); set role authenticated;
select public.delivery_approve(tst.pid(), tst.ps('projeto_arquitetonico'), null);
reset role;
select tst.ok(tst.st('estudo_preliminar__fb0') = 'completed', 'Aprovação direta conclui o feedback da apresentação');
select tst.ok((select count(*) from public.project_tasks where cycle_parent_id = (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id
               and status = 'cancelled' and waiting_reason like 'Dispensada%') = 6, 'Revisões não usadas dispensadas');
select tst.ok((tst.task('projeto_arquitetonico', 'alteracoes')).planned_start_date < (select s from alt), 'Alterações antecipada');


-- Padrões: salvar e copiar os campos
select tst.login('ga@hq'); set role authenticated;
create temp table dr as select public.create_template_draft(null, (select st.id from public.schedule_templates st join public.services s on s.id = st.service_id
  where s.code = 'projeto_arquitetonico' and st.active)) id;
select tst.ok((select review_cycle and review_days = 5 and feedback_days = 2 from public.template_tasks where template_id = (select id from dr) and code = 'estudo_preliminar'),
  'Nova versão copia a marcação de apresentação');
select tst.throws(format('select public.save_template_draft(%L, null, %L)', (select id from dr),
  '[{"name":"Estudo","duration_days":10,"review_cycle":true}]'), 'Apresentação exige o prazo da revisão');
select tst.throws(format('select public.save_template_draft(%L, null, %L)', (select id from dr),
  '[{"name":"Estudo","duration_days":10,"review_cycle":true,"review_days":5,"feedback_days":40}]'), 'Prazo do feedback limitado');
select public.save_template_draft((select id from dr), null, jsonb_build_array(
  jsonb_build_object('id', (select id from public.template_tasks where template_id = (select id from dr) and code = 'estudo_preliminar'),
    'name', 'Estudo Preliminar', 'duration_days', 20, 'review_cycle', true, 'review_days', 7),
  jsonb_build_object('name', 'Executivo', 'duration_days', 15, 'review_cycle', false, 'review_days', 9)));
select tst.ok((select review_days = 7 and feedback_days is null from public.template_tasks where template_id = (select id from dr) and code = 'estudo_preliminar')
  and (select not review_cycle and review_days is null from public.template_tasks where template_id = (select id from dr) and name = 'Executivo'),
  'Rascunho salva prazo da revisão; etapa interna fica sem rodadas');
reset role;
select tst.ok((private.cycle_durations((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id)).feedback_days = 2, 'Prazo do feedback vem do padrão do projeto');
