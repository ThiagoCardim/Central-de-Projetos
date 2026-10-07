-- Motivos padronizados de alteração de prazo e histórico visível ao cliente.
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
create function tst.reason(p_label text) returns uuid language sql as $$ select id from public.schedule_change_reasons where label = p_label $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','arq@hq','cli@x','cli2@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', null),
       ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt');

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "8001", "cliente": {"nome": "Iris", "email": "iris@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Iris", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
select public.ingest_crm_webhook('pipefy', '{"card_id": "8002", "cliente": {"nome": "Joel", "email": "joel@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Joel", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
create function tst.task(p_ext text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t where t.project_id = tst.pid(p_ext) and t.code = p_code $$;
grant execute on all functions in schema tst to authenticated;

insert into public.profiles (tenant_id, name, email, role, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Iris', 'cli@x', 'client', 'b2c'),
       ('00000000-0000-4000-8000-000000000001', 'Joel', 'cli2@x', 'client', 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Iris' from public.projects p where p.id = tst.pid('8001');
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli2@x'), 'Joel' from public.projects p where p.id = tst.pid('8002');

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(e), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', tst.uid('arq@hq'))))
from unnest(array['8001','8002']) e;

select tst.ok((select count(*) from public.schedule_change_reasons where active) >= 10, 'Motivos padrão disponíveis');
select tst.ok((select count(*) from public.schedule_change_reasons where is_other) = 1, 'Existe exatamente um "Outro motivo"');

-- Validações
select tst.throws(format('select public.reschedule_task_with_reason(%L, null, 25, null)', (tst.task('8001', 'planejamento')).id),
  'Motivo da lista é obrigatório');
select tst.throws(format('select public.reschedule_task_with_reason(%L, null, 25, %L, %L)', (tst.task('8001', 'planejamento')).id,
  tst.reason('Outro motivo'), ' '), '"Outro motivo" exige texto');

-- Motivo da lista
select tst.ok((public.reschedule_task_with_reason((tst.task('8001', 'planejamento')).id, null, 25,
  tst.reason('Solicitação do cliente')) ->> 'impacted_count')::int >= 1, 'Reprograma com motivo padronizado');
select tst.ok((select reason from public.task_changes where task_id = (tst.task('8001', 'planejamento')).id order by created_at desc limit 1)
  = 'Solicitação do cliente', 'Rótulo do motivo fica no histórico');
-- Outro motivo com texto livre
select public.reschedule_task_with_reason((tst.task('8001', 'estudo_preliminar')).id, null, 30,
  tst.reason('Outro motivo'), 'Cliente em viagem por duas semanas');
-- Motivo interno (não aparece ao cliente)
select public.reschedule_task_with_reason((tst.task('8001', 'alteracoes')).id, null, 22,
  tst.reason('Reorganização interna da equipe'), 'Férias da arquiteta');

-- O outro projeto não muda
select tst.ok(not exists (select 1 from public.task_changes where project_id = tst.pid('8002') and change_type in ('reschedule','duration')),
  'Alteração não afeta outros projetos');

-- Permissões de cadastro de motivos
select tst.throws($$insert into public.schedule_change_reasons (label) values ('Chuva')$$, 'Líder não cadastra motivo');
reset role;

select tst.login('ga@hq'); set role authenticated;
insert into public.schedule_change_reasons (label, client_visible) values ('Chuva forte na obra', true);
select tst.throws($$insert into public.schedule_change_reasons (label, is_other) values ('Outro 2', true)$$, 'Só um "Outro motivo"');
reset role;

-- Visão do cliente
select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(public.client_schedule_changes()) = 2, 'Cliente vê 2 alterações (motivo interno fica oculto)');
select tst.ok(public.client_schedule_changes() @> '[{"reason": "Solicitação do cliente"}]', 'Cliente vê o motivo padronizado');
select tst.ok(public.client_schedule_changes() @> '[{"reason": "Cliente em viagem por duas semanas"}]', 'Cliente vê o texto de "Outro motivo"');
select tst.ok(not (public.client_schedule_changes()::text like '%Férias%'), 'Detalhe de motivo interno não vaza');
select tst.ok((public.client_schedule_changes() -> 0 ->> 'after_end') is not null, 'Datas antes e depois');
select tst.ok((select count(*) from public.schedule_change_reasons) = 0, 'Cliente não lê a lista de motivos');
reset role;

select tst.login('cli2@x'); set role authenticated;
select tst.ok(jsonb_array_length(public.client_schedule_changes()) = 0, 'Outro cliente não vê alterações alheias');
select tst.ok(jsonb_array_length(public.client_schedule_changes(tst.pid('8001'))) = 0, 'Nem pedindo o projeto pelo id');
reset role;
