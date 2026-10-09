-- Customer Success: visualização sem alteração, chamados à equipe e painel.
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
select public.ingest_crm_webhook('pipefy', '{"card_id": "9951", "cliente": {"nome": "Dora", "email": "dora@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Dora", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
select public.ingest_crm_webhook('pipefy', '{"card_id": "9952", "cliente": {"nome": "Edu", "email": "edu@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Edu", "area_m2": "120"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
insert into public.tenants (id, name, type, status, parent_tenant_id, slug)
values ('00000000-0000-4000-8000-0000000000f1', 'Franquia Sul', 'franquia', 'ativo', '00000000-0000-4000-8000-000000000001', 'sul');

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','col@hq','cs@hq','adm@hq','fora@hq','cs@sul']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder Ana', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab Beto', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Fora', 'fora@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-0000000000f1', 'Sara CS Sul', 'cs@sul', 'customer_success', 'pj', null);
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

-- Casa Edu é executada pela franquia
update public.projects set delivery_tenant_id = '00000000-0000-4000-8000-0000000000f1', commercial_tenant_id = '00000000-0000-4000-8000-0000000000f1'
 where external_id = '9952';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9951' $$;
create function tst.pid2() returns uuid language sql as $$ select id from public.projects where external_id = '9952' $$;
create function tst.task() returns uuid language sql as $$ select id from public.project_tasks where project_id = tst.pid() order by sequence limit 1 $$;
create function tst.req() returns public.cs_requests language sql security definer as $$ select * from public.cs_requests where project_id = tst.pid() order by created_at limit 1 $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', (select id from public.project_services where project_id = tst.pid()), 'user_id', tst.uid('col@hq'))));
select public.set_task_status(tst.task(), 'in_progress');
reset role;

-- Visualização
select tst.login('cs@hq'); set role authenticated;
select tst.ok(private.can_view_project(tst.pid()) and private.can_view_project(tst.pid2()), 'CS da Franqueadora vê a rede toda');
select tst.ok((select count(*) from public.project_tasks where project_id = tst.pid()) > 0, 'CS vê o cronograma');
select tst.ok((select count(*) from public.project_team where project_id = tst.pid()) > 0, 'CS vê a equipe do projeto');
select tst.ok((select count(*) from public.clients) >= 2, 'CS vê os clientes');
select tst.ok(private.can_view_profile(tst.uid('cs@sul')), 'CS da Franqueadora vê pessoas das franquias');
select tst.ok((public.my_permissions() ->> 'is_cs')::boolean and not (public.my_permissions() ->> 'is_manager')::boolean
  and not (public.my_permissions() ->> 'can_view_performance')::boolean, 'Permissões: CS, sem gestão e sem performance');
reset role;
select tst.login('cs@sul'); set role authenticated;
select tst.ok(private.can_view_project(tst.pid2()) and not private.can_view_project(tst.pid()), 'CS da franquia vê só a própria unidade');
reset role;

-- Nada de alterar
select tst.login('cs@hq'); set role authenticated;
update public.project_tasks set notes = 'mexi' where project_id = tst.pid();
update public.projects set name = 'mexi' where id = tst.pid();
select tst.throws(format('select public.set_task_status(%L, %L, null)', tst.task(), 'completed'), 'CS não muda status de etapa');
select tst.throws(format('select public.reschedule_task(%L, current_date + 30, null, %L)', tst.task(), 'Cliente pediu'), 'CS não muda prazo');
select tst.throws(format('select public.assign_project_team(%L, %L::jsonb)', tst.pid(),
  jsonb_build_array(jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('cs@hq')))), 'CS não muda a equipe');
select tst.throws(format('select public.board_move_card(%L, (select id from public.project_board_columns limit 1), null)', tst.pid()), 'CS não arrasta o quadro');
select tst.throws(format('select public.adjustment_create(%L, %L, %L, null, null)', tst.task(), 'simple', 'Cliente pediu ajuste'), 'CS não pede ajuste de prazo');
select tst.ok(public.add_task_note(tst.task(), 'Cliente perguntou sobre esta etapa') is not null, 'CS pode deixar observação na etapa');
reset role;
select tst.ok((select count(*) from public.project_tasks where project_id = tst.pid() and notes = 'mexi') = 0, 'Etapas não foram alteradas');
select tst.ok((select name from public.projects where id = tst.pid()) = 'Casa Dora', 'Projeto não foi alterado');

-- Chamados
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.cs_request_create(%L, %L, null, %L, %L, null)', tst.pid(), 'clarification', 'Status?', 'Como está?'), 'Colaborador não abre chamado de CS');
reset role;
select tst.login('cs@hq'); set role authenticated;
select public.cs_request_create(tst.pid(), 'alert', null, 'Cliente sem retorno há 10 dias', 'Precisa de contato hoje.', tst.task());
select tst.throws(format('select public.cs_request_create(%L, %L, null, %L, %L, null)', tst.pid(), 'outro', 'xx', 'yy'), 'Tipo inválido recusado');
reset role;
select tst.ok((tst.req()).urgency = 'urgent' and (tst.req()).recipients = array[tst.uid('lid@hq')], 'Alerta é urgente e vai para os líderes do projeto');
select tst.ok((tst.req()).due_at between now() + interval '3 hours 59 minutes' and now() + interval '4 hours 1 minute', 'Urgente: prazo de 4 horas');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('lid@hq') and kind = 'cs_alert'), 'Líder recebe o alerta');

select tst.login('lid@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.cs_requests_list('mine', null)) = 1, 'Líder vê o chamado em “para mim”');
select public.cs_request_reply((tst.req()).id, 'Ligamos para o cliente hoje às 15h.');
reset role;
select tst.ok((tst.req()).status = 'answered' and (tst.req()).first_response_at is not null, 'Resposta da equipe marca como respondido');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('cs@hq') and kind = 'cs_reply'), 'CS é avisada da resposta');

select tst.login('cs@hq'); set role authenticated;
select public.cs_request_reply((tst.req()).id, 'O cliente ainda quer a previsão do Estudo Preliminar.');
reset role;
select tst.ok((tst.req()).status = 'open', 'Nova pergunta do CS volta a aguardar a equipe');

select tst.login('col@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.cs_requests_list('project', tst.pid())) = 1, 'Equipe do projeto vê o chamado');
select tst.ok(jsonb_array_length(public.cs_request_detail((tst.req()).id) -> 'thread') = 2, 'Conversa com 2 mensagens');
select tst.throws(format('select public.cs_request_set_status(%L, %L)', (tst.req()).id, 'resolved'), 'Colaborador não encerra chamado');
reset role;
select tst.login('fora@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.cs_requests_list('all', null)) = 0, 'Quem não é do projeto não vê o chamado');
reset role;

select tst.login('cs@hq'); set role authenticated;
select public.cs_request_set_status((tst.req()).id, 'resolved');
create temp table dash as select public.cs_dashboard() as j;
reset role;
select tst.ok((tst.req()).status = 'resolved', 'CS encerra o chamado');
select tst.ok((select (j -> 'counts' ->> 'resolved_month')::int from dash) = 1, 'Painel conta resolvidos no mês');
select tst.ok((select (j -> 'response' ->> 'on_time_pct')::int from dash) = 100, 'Painel mede resposta no prazo');
select tst.ok((select (j -> 'projects' ->> 'active')::int from dash) >= 1, 'Painel conta projetos em andamento');
select tst.ok((select jsonb_array_length(j -> 'trend') from dash) = 8, 'Tendência de 8 semanas');
select tst.login('col@hq'); set role authenticated;
select tst.throws($$select public.cs_dashboard()$$, 'Colaborador não abre o painel de CS');
reset role;

-- Prazos configuráveis
select tst.login('cs@hq'); set role authenticated;
select tst.throws(format('select public.cs_settings_save(%L, 3, 1, 8)', '00000000-0000-4000-8000-000000000001'), 'CS não muda os prazos');
reset role;
select tst.login('adm@hq'); set role authenticated;
select tst.throws(format('select public.cs_settings_save(%L, 1, 2, 8)', '00000000-0000-4000-8000-000000000001'), 'Alta não pode ser mais longa que Normal');
select public.cs_settings_save('00000000-0000-4000-8000-000000000001', 3, 1, 8);
select tst.ok((public.cs_settings_get('00000000-0000-4000-8000-000000000001') ->> 'urgent_hours')::int = 8, 'ADM ajusta os prazos');
reset role;
select tst.ok(private.cs_due_at('00000000-0000-4000-8000-000000000001', 'urgent', now()) between now() + interval '7 hours 59 minutes' and now() + interval '8 hours 1 minute',
  'Urgente passa a 8 horas');
select tst.ok((private.cs_due_at('00000000-0000-4000-8000-000000000001', 'normal', now()) at time zone 'America/Sao_Paulo')::time = '18:00',
  'Normal vence às 18h de um dia útil');
