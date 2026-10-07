-- Reabertura de etapa concluída: retrabalho, cascata no contrato, guarda e visão do cliente.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','arq@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt');

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9101", "cliente": {"nome": "Rui", "email": "rui@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Rui", "area_m2": "150"},
  "servicos": "Projeto Arquitetônico, Projeto Estrutural, Projeto Elétrico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9101' $$;
create function tst.task(p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  join public.project_services ps on ps.id = tr.project_service_id
  join public.services s on s.id = ps.service_id
  where t.project_id = tst.pid() and s.code = p_service and t.code = p_code $$;
grant execute on all functions in schema tst to authenticated;

insert into public.profiles (tenant_id, name, email, role, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Rui', 'cli@x', 'client', 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Rui' from public.projects p where p.id = tst.pid();

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', tst.uid('arq@hq'))));
-- Arquitetura avança: Planejamento, Briefing e Estudo concluídos; Alterações em andamento.
select public.set_task_status((tst.task('projeto_arquitetonico', c)).id, s::public.task_status)
from (values ('planejamento','in_progress',1),('planejamento','completed',2),('envio_briefing','in_progress',3),('envio_briefing','completed',4),
             ('estudo_preliminar','in_progress',5),('estudo_preliminar','completed',6),('alteracoes','in_progress',7)) v(c, s, o) order by o;
select public.set_task_responsible((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, tst.uid('arq@hq'));
reset role;
-- Conclusão no passado (o caso comum): término real e previsto 3 semanas atrás.
begin;
select private.engine_on();
update public.project_tasks set actual_start_date = current_date - 40, planned_start_date = current_date - 40,
       actual_end_date = current_date - 21, planned_end_date = current_date - 21
 where id = (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id;
commit;

-- Guarda: concluída não volta por outro caminho
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.set_task_status(%L, %L)', (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'in_progress'),
  'Concluída não reabre pelo botão de status');
reset role;
select tst.login('arq@hq'); set role authenticated;
select tst.throws(format('select public.reopen_task(%L, null, 7, %L)', (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id,
  tst.reason('Cliente pediu alteração em etapa já concluída')), 'Colaborador não reabre etapa');
reset role;

create table tst.before as select id, planned_start_date as s, planned_end_date as e, status from public.project_tasks where project_id = tst.pid();
grant select on tst.before to authenticated;

-- Prévia não altera nada
select tst.login('lid@hq'); set role authenticated;
create temp table pv as select public.preview_task_reopen((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, null, 7) as j;
select tst.ok((select (j ->> 'delay_days')::int from pv) = 7, 'Prévia: 7 dias úteis de retrabalho');
select tst.ok((select (j ->> 'other_services_count')::int from pv) >= 2, 'Prévia mostra os outros serviços do contrato');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).status = 'completed', 'Prévia não reabre a etapa');
select tst.ok(not exists (select 1 from public.task_changes where change_type = 'status' and after ? 'reopened'), 'Prévia não grava histórico');
select tst.throws(format('select public.reopen_task(%L, null, 7, null)', (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id),
  'Reabertura exige motivo');
select tst.throws(format('select public.reopen_task(%L, null, 7, %L)', (tst.task('projeto_arquitetonico', 'alteracoes')).id,
  tst.reason('Cliente pediu alteração em etapa já concluída')), 'Só etapa concluída pode ser reaberta');

select public.reopen_task((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, null, 7,
  tst.reason('Cliente pediu alteração em etapa já concluída'), 'Mudou a posição da escada');
reset role; select tst.login('');

select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).status = 'in_progress'
          and (tst.task('projeto_arquitetonico', 'estudo_preliminar')).reopen_count = 1
          and (tst.task('projeto_arquitetonico', 'estudo_preliminar')).planned_end_date =
              public.add_business_days((tst.task('projeto_arquitetonico', 'estudo_preliminar')).actual_start_date, 7, '00000000-0000-4000-8000-000000000101'),
  'Etapa reaberta em andamento com 7 dias úteis de retrabalho');
select tst.ok((tst.task('projeto_arquitetonico', 'alteracoes')).planned_start_date = (select s from tst.before where id = (tst.task('projeto_arquitetonico', 'alteracoes')).id),
  'Etapa em andamento não muda');
select tst.ok(not exists (
  select 1 from tst.before b join public.project_tasks t on t.id = b.id
  where t.actual_start_date is null and t.status not in ('completed','cancelled') and b.s is not null
    and t.planned_start_date < public.add_business_days(b.s, 8, '00000000-0000-4000-8000-000000000101')),
  'Todas as etapas não iniciadas do contrato andaram 7 dias úteis');
select tst.ok((tst.task('projeto_eletrico', 'planejamento')).planned_start_date > (select s from tst.before where id = (tst.task('projeto_eletrico', 'planejamento')).id),
  'Outro serviço (Elétrico) também andou');
select tst.ok(exists (select 1 from public.notifications where title = 'Etapa reaberta' and recipient_profile_id = tst.uid('arq@hq')),
  'Responsável é avisado da reabertura');

-- Cliente vê a reabertura com o motivo
select tst.login('cli@x'); set role authenticated;
select tst.ok(public.client_schedule_changes() @> '[{"change_type": "reopened", "reason": "Cliente pediu alteração em etapa já concluída", "reason_detail": "Mudou a posição da escada"}]',
  'Cliente vê a reabertura e o motivo');
reset role;

-- Concluir de novo continua funcionando
select tst.login('lid@hq'); set role authenticated;
select public.set_task_status((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'completed');
reset role;
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).status = 'completed', 'Retrabalho concluído normalmente');
