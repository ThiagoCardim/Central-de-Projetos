-- Minhas tarefas: checklist pessoal e etapas sob minha responsabilidade.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','arq@hq','out@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Outra', 'out@hq', 'collaborator', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9501", "cliente": {"nome": "Ana", "email": "ana@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Ana", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9501' $$;
create function tst.task(p_code text) returns public.project_tasks language sql as $$ select * from public.project_tasks where project_id = tst.pid() and code = p_code $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', tst.uid('arq@hq'))));
select public.set_task_responsible((tst.task(c)).id, tst.uid('arq@hq')) from unnest(array['planejamento', 'envio_briefing']) c;
reset role;

select tst.login('arq@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.my_steps()) = 2, 'Arquiteta vê as 2 etapas sob sua responsabilidade');
select tst.ok(public.my_steps() -> 0 ->> 'project_name' = 'Casa Ana', 'Etapa traz o projeto');
insert into public.work_items (title, project_task_id) values ('Levantar fotos do terreno', (tst.task('planejamento')).id);
insert into public.work_items (title, due_date) values ('Ligar para o cliente', current_date - 1);
select tst.ok((select project_id from public.work_items where title = 'Levantar fotos do terreno') = tst.pid(), 'Tarefa ligada à etapa recebe o projeto');
update public.work_items set done_at = now() where title = 'Ligar para o cliente';
select tst.ok((select count(*) from public.work_items where done_at is not null) = 1, 'Marca como feita');
delete from public.work_items where title = 'Ligar para o cliente';
select tst.ok((select count(*) from public.work_items) = 1, 'Exclui a própria tarefa');
reset role;

create table tst.ids as select (tst.task('planejamento')).id as plan_id;
grant select on tst.ids to authenticated;
select tst.login('out@hq'); set role authenticated;
select tst.ok((select count(*) from public.work_items) = 0, 'Outra pessoa não vê as tarefas da arquiteta');
select tst.ok(jsonb_array_length(public.my_steps()) = 0, 'Outra pessoa não tem etapas');
select tst.throws(format('insert into public.work_items (title, project_task_id) values (%L, %L)', 'x', (select plan_id from tst.ids)),
  'Não liga tarefa a etapa de projeto que não vê');
select tst.throws(format('insert into public.work_items (owner_id, title) values (%L, %L)', tst.uid('arq@hq'), 'x'),
  'Não cria tarefa para outra pessoa');
reset role;
