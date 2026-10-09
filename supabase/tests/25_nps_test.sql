-- NPS: pesquisa ao concluir um serviço, respostas e indicadores.
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
select public.ingest_crm_webhook('pipefy', '{"card_id": "9971", "cliente": {"nome": "Gil", "email": "gil@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Gil", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','col@hq','cs@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder Ana', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab Beto', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Cliente Gil', 'cli@x', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Cliente Gil' from public.projects p where p.external_id = '9971';

create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9971' $$;
create function tst.ps(p_code text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id where ps.project_id = tst.pid() and s.code = p_code $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;

select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(public.nps_pending()) = 0, 'Sem serviço concluído, sem pesquisa');
reset role;

-- Conclui todas as etapas do Projeto Arquitetônico
select tst.login('lid@hq'); set role authenticated;
do $$
declare t record;
begin
  for t in select pt.id from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
           where tr.project_service_id = tst.ps('projeto_arquitetonico') order by pt.sequence loop
    perform public.set_task_status(t.id, 'completed');
  end loop;
end $$;
reset role;

select tst.login('cli@x'); set role authenticated;
create temp table pend as select public.nps_pending() as j;
select tst.ok((select jsonb_array_length(j) from pend) = 1 and (select j -> 0 ->> 'service_name' from pend) = 'Projeto Arquitetônico',
  'Serviço concluído abre a pesquisa para o cliente');
select public.nps_skip(tst.ps('projeto_arquitetonico'), 'later');
select tst.ok(jsonb_array_length(public.nps_pending()) = 0, '“Responder depois” some por enquanto');
reset role;
update public.nps_responses set snoozed_until = now() - interval '1 minute';
select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(public.nps_pending()) = 1, 'Depois do prazo, volta a aparecer');
select tst.throws(format('select public.nps_answer(%L, 11, null)', tst.ps('projeto_arquitetonico')), 'Nota fora de 0 a 10 recusada');
select tst.throws(format('select public.nps_answer(%L, 8, null)', tst.ps('projeto_estrutural')), 'Serviço não concluído não tem pesquisa');
select public.nps_answer(tst.ps('projeto_arquitetonico'), 4, 'Demorou mais do que o combinado.');
select tst.ok(jsonb_array_length(public.nps_pending()) = 0, 'Respondida, não aparece mais');
select tst.throws(format('select public.nps_answer(%L, 9, null)', tst.ps('projeto_arquitetonico')), 'Não responde duas vezes');
select tst.throws($$select public.nps_overview(null, null, null)$$, 'Cliente não vê os indicadores');
reset role;
select tst.ok(exists (select 1 from public.notifications where kind = 'nps_detractor' and recipient_role = 'customer_success'), 'Detrator avisa o Customer Success');

select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.nps_answer(%L, 10, null)', tst.ps('projeto_arquitetonico')), 'Só o cliente responde');
reset role;

select tst.login('cs@hq'); set role authenticated;
create temp table ov as select public.nps_overview(null, null, null) as j;
select tst.ok((select (j ->> 'responses')::int from ov) = 1 and (select (j ->> 'detractors')::int from ov) = 1, 'Conta respostas e detratores');
select tst.ok((select (j ->> 'nps')::int from ov) = -100, 'NPS = % promotores - % detratores');
select tst.ok((select (j ->> 'completed_services')::int from ov) = 1 and (select (j ->> 'answered_services')::int from ov) = 1, 'Taxa de resposta por serviço');
select tst.ok((select (j -> 'distribution' ->> 4)::int from ov) = 1, 'Distribuição das notas');
select tst.ok((select jsonb_array_length(j -> 'by_month') from ov) = 6, 'Evolução de 6 meses');
select tst.ok((public.nps_responses_list(null, null, null) -> 0 ->> 'comment') = 'Demorou mais do que o combinado.', 'CS lê os comentários');
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.throws($$select public.nps_overview(null, null, null)$$, 'Colaborador não vê o NPS');
reset role;
