-- Automações por usuário: cada um vê e edita as suas; rodam com o acesso do dono.
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
grant execute on all functions in schema tst to authenticated, service_role;

insert into public.tenants (id, name, type, parent_tenant_id, slug) values
  ('00000000-0000-4000-8000-00000000000a', 'Franquia A', 'franquia', '00000000-0000-4000-8000-000000000001', 'franquia-a');
insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid1@hq','lid2@hq','arq@hq','adm@a']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder Um', 'lid1@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Líder Dois', 'lid2@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-00000000000a', 'ADM Franquia', 'adm@a', 'unit_admin', null);
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

-- Sem franquias ativas no momento da venda: projeto fica com a Franqueadora
update public.tenants set status = 'inativo' where id = '00000000-0000-4000-8000-00000000000a';
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9301", "cliente": {"nome": "Lia", "email": "lia@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Lia", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
update public.tenants set status = 'ativo' where id = '00000000-0000-4000-8000-00000000000a';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9301' $$;
create function tst.task(p_code text) returns public.project_tasks language sql as $$
  select * from public.project_tasks where project_id = tst.pid() and code = p_code $$;
grant execute on all functions in schema tst to authenticated;

-- Cada líder cria a sua automação "me avise quando uma etapa for iniciada"
select tst.login('lid1@hq'); set role authenticated;
select public.automation_save(null, '{"name":"Aviso do Líder Um","trigger":"task_started","actions":[{"type":"notify","recipients":["owner"],"title":"Iniciada: {etapa}"}]}'::jsonb);
reset role;
select tst.login('lid2@hq'); set role authenticated;
select public.automation_save(null, '{"name":"Aviso do Líder Dois","trigger":"task_started","actions":[{"type":"notify","recipients":["owner"],"title":"Dois: {etapa}"}]}'::jsonb);
select tst.ok((select count(*) from public.automation_rules) = 1, 'Líder Dois vê só a própria automação');
select tst.throws(format('select public.automation_set_active(%L, false)', (select id from public.automation_rules where name = 'Aviso do Líder Um' limit 1)),
  'Não desliga a automação de outra pessoa');
reset role;
select tst.login('adm@a'); set role authenticated;
select public.automation_save(null, '{"name":"Aviso da Franquia","trigger":"task_started","actions":[{"type":"notify","recipients":["owner"],"title":"Franquia: {etapa}"}]}'::jsonb);
reset role;
select tst.login('arq@hq'); set role authenticated;
select tst.throws($$select public.automation_save(null, '{"name":"x","trigger":"task_started","actions":[{"type":"notify","recipients":["owner"],"title":"t"}]}'::jsonb)$$,
  'Colaborador sem acesso às automações');
select tst.ok((select count(*) from public.automation_rules) = 0, 'Colaborador não vê automações de ninguém');
reset role;

-- Líder Dois desliga a dele; Líder Um continua
select tst.login('lid2@hq'); set role authenticated;
select public.automation_set_active((select id from public.automation_rules where name = 'Aviso do Líder Dois'), false);
reset role;

-- Evento: etapa iniciada
select tst.login('lid1@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid1@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid1@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid1@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', tst.uid('arq@hq'))));
select public.set_task_status((tst.task('planejamento')).id, 'in_progress');
reset role; select tst.login('');

select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('lid1@hq') and title = 'Iniciada: Planejamento'),
  'Automação do Líder Um avisou o próprio Líder Um');
select tst.ok(not exists (select 1 from public.notifications where title like 'Dois:%'), 'Automação desligada não roda');
select tst.ok(not exists (select 1 from public.notifications where title like 'Franquia:%'),
  'Automação da franquia não roda em projeto que ela não enxerga');

-- Dono inativo: automação para
update public.profiles set status = 'inativo' where email = 'lid1@hq';
select tst.login('lid2@hq'); set role authenticated;
select public.set_task_status((tst.task('planejamento')).id, 'completed');
select public.set_task_status((tst.task('envio_briefing')).id, 'in_progress');
reset role; select tst.login('');
select tst.ok(not exists (select 1 from public.notifications where title = 'Iniciada: Envio do Briefing'),
  'Dono inativo: as automações dele param');

-- Histórico: cada um vê só o das suas
select tst.login('lid2@hq'); set role authenticated;
select tst.ok((select count(*) from public.automation_runs) = 0, 'Histórico mostra só as execuções das próprias automações');
reset role;
