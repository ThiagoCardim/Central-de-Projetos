-- Tarefas atribuídas pela liderança.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','arq@hq','out@hq','adm@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Outra', 'out@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9601", "cliente": {"nome": "Ana", "email": "ana@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Ana", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team((select id from public.projects where external_id = '9601'), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;
create table tst.ids as
  select (select id from public.projects where external_id = '9601') as pid,
         (select t.id from public.project_tasks t join public.projects p on p.id = t.project_id where p.external_id = '9601' and t.code = 'planejamento') as plan_id;
grant select on tst.ids to authenticated;

-- Líder vê a equipe e atribui
select tst.login('lid@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.assignable_people()) = 2, 'Líder pode atribuir para os 2 colaboradores (não para a admin)');
select tst.ok(public.assign_work_items(array[tst.uid('arq@hq'), tst.uid('out@hq')], 'Organizar acervo de pranchas', current_date - 1,
  'Separar por cliente', null, null) = 2, 'Cria a mesma tarefa para duas pessoas');
select public.assign_work_items(array[tst.uid('arq@hq')], 'Revisar memorial', current_date + 2, null, (select plan_id from tst.ids), null);
select tst.throws(format('select public.assign_work_items(array[%L]::uuid[], %L, current_date)', tst.uid('adm@hq'), 'x'),
  'Líder não atribui para nível acima');
select tst.ok(jsonb_array_length(public.team_work_items()) = 3, 'Líder acompanha as 3 tarefas atribuídas');
select tst.ok((select count(*) from public.work_items where assigned_by = tst.uid('lid@hq')) = 3, 'Tarefas registram quem atribuiu');
select tst.ok((public.team_work_items() -> 2 ->> 'project_name') = 'Casa Ana' or (public.team_work_items() -> 0 ->> 'project_name') = 'Casa Ana'
  or (public.team_work_items() -> 1 ->> 'project_name') = 'Casa Ana', 'Tarefa ligada à etapa traz o projeto');
reset role;

select tst.ok((select count(*) from public.notifications where kind = 'work_assigned' and recipient_profile_id = tst.uid('arq@hq')) = 2,
  'Arquiteta recebe aviso das 2 tarefas');

-- Colaboradora: vê, marca como feita, não edita nem exclui
select tst.login('arq@hq'); set role authenticated;
insert into public.work_items (title) values ('Tarefa pessoal');
select tst.ok(jsonb_array_length(public.my_work_items()) = 3, 'Arquiteta vê 2 atribuídas + 1 pessoal');
select tst.ok((select count(*) from jsonb_array_elements(public.my_work_items()) x where x -> 'assigned_by' ->> 'name' = 'Líder') = 2,
  'Mostra quem atribuiu');
update public.work_items set done_at = now() where title = 'Organizar acervo de pranchas';
select tst.ok((select done_at is not null from public.work_items where title = 'Organizar acervo de pranchas'), 'Marca a atribuída como feita');
select tst.throws($$update public.work_items set due_date = current_date + 10 where title = 'Revisar memorial'$$, 'Não remarca tarefa atribuída');
select tst.throws($$update public.work_items set title = 'outra' where title = 'Revisar memorial'$$, 'Não renomeia tarefa atribuída');
delete from public.work_items where title = 'Revisar memorial';
select tst.ok((select count(*) from public.work_items where title = 'Revisar memorial') = 1, 'Não exclui tarefa atribuída');
select tst.throws(format('select public.assign_work_items(array[%L]::uuid[], %L, current_date)', tst.uid('out@hq'), 'x'),
  'Colaboradora não atribui tarefas');
reset role;

-- Líder: não vê tarefa pessoal, acompanha a feita, edita e reatribui
select tst.login('lid@hq'); set role authenticated;
select tst.ok((select count(*) from public.work_items where title = 'Tarefa pessoal') = 0, 'Líder não vê tarefas pessoais');
select tst.ok((select count(*) from jsonb_array_elements(public.team_work_items()) x where x ->> 'done_at' is not null) = 1, 'Líder vê a feita');
select tst.throws($$update public.work_items set done_at = now() where title = 'Revisar memorial'$$, 'Líder não marca como feita pelo colaborador');
update public.work_items set due_date = current_date + 5, title = 'Revisar memorial descritivo' where title = 'Revisar memorial';
select tst.ok((select due_date from public.work_items where title = 'Revisar memorial descritivo') = current_date + 5, 'Líder remarca e renomeia');
update public.work_items set owner_id = tst.uid('out@hq') where title = 'Revisar memorial descritivo';
select tst.ok((select owner_id from public.work_items where title = 'Revisar memorial descritivo') = tst.uid('out@hq'), 'Líder reatribui');
select tst.ok((select assigned_by from public.work_items where title = 'Revisar memorial descritivo') = tst.uid('lid@hq'), 'Mantém quem atribuiu');
select tst.throws(format('update public.work_items set owner_id = %L where title = %L', tst.uid('adm@hq'), 'Revisar memorial descritivo'),
  'Não reatribui para nível acima');
delete from public.work_items where title = 'Revisar memorial descritivo';
select tst.ok((select count(*) from public.work_items where title = 'Revisar memorial descritivo') = 0, 'Líder exclui tarefa que atribuiu');
reset role;

select tst.ok((select count(*) from public.notifications where kind = 'work_assigned' and recipient_profile_id = tst.uid('out@hq')) = 2,
  'Nova responsável recebe aviso na reatribuição');

-- Admin da unidade acompanha o que a liderança atribuiu
select tst.login('adm@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.team_work_items()) = 2, 'Admin da unidade acompanha as tarefas da equipe');
select tst.ok(jsonb_array_length(public.assignable_people()) = 3, 'Admin pode atribuir para líder e colaboradores');
reset role;
