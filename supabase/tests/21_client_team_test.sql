-- Funções da equipe e "Equipe do seu projeto" para o cliente.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','eng@hq','adm@hq','cli@x','fora@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder Ana', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Eng. Bruno', 'eng@hq', 'collaborator', 'pj', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Cliente Carla', 'cli@x', 'client', null, 'b2c'),
       ('00000000-0000-4000-8000-000000000001', 'Fora do projeto', 'fora@hq', 'collaborator', 'clt', null);
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9801", "cliente": {"nome": "Carla", "email": "carla@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Carla", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Cliente Carla' from public.projects p where p.external_id = '9801';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9801' $$;
create function tst.fn(p text, s text) returns uuid language sql as $$
  select id from public.job_functions where tenant_id = '00000000-0000-4000-8000-000000000001' and profession = p and specialty = s $$;
grant execute on all functions in schema tst to authenticated;

-- Funções iniciais e cadastro só pela administração
select tst.ok((select count(*) from public.job_functions where tenant_id = '00000000-0000-4000-8000-000000000001') = 5, 'Unidade nasce com 5 funções');
select tst.login('lid@hq'); set role authenticated;
select tst.throws($$select public.job_function_save('00000000-0000-4000-8000-000000000001', null, 'Engenheiro', 'Ambiental')$$, 'Líder não cria função');
reset role;
select tst.login('adm@hq'); set role authenticated;
select public.job_function_save('00000000-0000-4000-8000-000000000001', null, 'Engenheiro', 'Ambiental');
select tst.throws($$select public.job_function_save('00000000-0000-4000-8000-000000000001', null, 'engenheiro', 'ambiental')$$, 'Função repetida é recusada');
select tst.ok(jsonb_array_length(public.job_function_list('00000000-0000-4000-8000-000000000001')) = 6, 'ADM inclui função');
reset role;

-- Equipe do projeto
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', (select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
                                             where ps.project_id = tst.pid() and s.code = 'projeto_estrutural'), 'user_id', tst.uid('eng@hq'))));
select public.set_person_profile(tst.uid('eng@hq'), array[tst.fn('Engenheiro', 'Estrutural'), tst.fn('Engenheiro', 'Elétrico')],
  'Engenheiro civil com 10 anos em estruturas residenciais.');
select tst.throws(format('select public.set_person_profile(%L, array[%L]::uuid[], null)', tst.uid('eng@hq'), gen_random_uuid()), 'Função de fora da unidade é recusada');
reset role;

select tst.login('eng@hq'); set role authenticated;
select tst.throws(format('select public.set_person_profile(%L, null, %L)', tst.uid('fora@hq'), 'x'), 'Colaborador não altera o perfil de outro');
reset role;

-- Cliente vê quem cuida do projeto
select tst.login('cli@x'); set role authenticated;
create temp table team as select public.client_project_team(tst.pid()) as j;
select tst.ok((select jsonb_array_length(j) from team) = 2, 'Cliente vê as 2 pessoas da equipe (líder e engenheiro)');
select tst.ok((select j -> 0 ->> 'name' from team) = 'Líder Ana', 'Liderança aparece primeiro');
select tst.ok((select (j -> 0 ->> 'is_leader')::boolean from team), 'Marca quem é líder');
select tst.ok((select x -> 'functions' from team, jsonb_array_elements(j) x where x ->> 'name' = 'Eng. Bruno') = '["Engenheiro › Estrutural", "Engenheiro › Elétrico"]'::jsonb,
  'Mostra as funções do engenheiro');
select tst.ok((select x ->> 'bio' from team, jsonb_array_elements(j) x where x ->> 'name' = 'Eng. Bruno') like 'Engenheiro civil%', 'Mostra a descrição');
select tst.ok((select x -> 'roles' from team, jsonb_array_elements(j) x where x ->> 'name' = 'Eng. Bruno') ? 'Responsável por Projeto Estrutural',
  'Mostra o serviço sob responsabilidade');
select tst.ok(not exists (select 1 from team, jsonb_array_elements(j) x where x ? 'email'), 'Não expõe e-mail');
reset role;

select tst.login('fora@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.client_project_team(tst.pid())) = 0, 'Quem não vê o projeto não vê a equipe');
reset role;

-- Excluir função remove das pessoas
select tst.login('adm@hq'); set role authenticated;
select tst.ok(public.job_function_delete(tst.fn('Engenheiro', 'Elétrico')) = 1, 'Excluir função informa quantas pessoas tinham');
reset role;
select tst.ok((select function_ids from public.profiles where email = 'eng@hq') = array[tst.fn('Engenheiro', 'Estrutural')], 'Função excluída sai da pessoa');
