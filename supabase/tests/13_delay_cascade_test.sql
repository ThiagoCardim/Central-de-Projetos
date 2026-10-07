-- Atraso numa etapa empurra as etapas à frente de todos os serviços do mesmo contrato.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tst;
grant usage on schema tst to authenticated, service_role;
create function tst.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALHOU: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create function tst.login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',
    coalesce((select auth_user_id::text from public.profiles where email = p_email), ''), false);
end $$;
create function tst.uid(p_email text) returns uuid language sql as $$ select id from public.profiles where email = p_email $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','arq@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9001", "cliente": {"nome": "Lia", "email": "lia@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Lia", "area_m2": "150"},
  "servicos": "Projeto Arquitetônico, Projeto Estrutural, Projeto Elétrico, Projeto Hidrossanitário", "data_fechamento": "01/10/2026"}'::jsonb);
select public.ingest_crm_webhook('pipefy', '{"card_id": "9002", "cliente": {"nome": "Max", "email": "max@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Max", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
create function tst.task(p_ext text, p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  join public.project_services ps on ps.id = tr.project_service_id
  join public.services s on s.id = ps.service_id
  where t.project_id = tst.pid(p_ext) and s.code = p_service and t.code = p_code $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(e), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'architecture', 'user_id', tst.uid('arq@hq'))))
from unnest(array['9001','9002']) e;
-- Uma etapa em andamento em outro serviço: não deve mudar.
select public.set_task_status((tst.task('9001', 'projeto_arquitetonico', 'planejamento')).id, 'in_progress');
reset role;

-- Fotografia antes
create table tst.before as
  select t.id, t.project_id, t.planned_start_date as s, t.planned_end_date as e, tr.project_service_id as ps
  from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id;
grant select on tst.before to authenticated;
-- Revisão do Estrutural: Elétrico e Hidrossanitário não dependem dela pelo template.
create table tst.ref as select (tst.task('9001', 'projeto_estrutural', 'revisao_apr_arq_eng')).*;
grant select on tst.ref to authenticated;

select tst.ok((select count(*) from tst.before b where b.project_id = tst.pid('9001') and b.ps <> (select tr.project_service_id from public.project_schedule_tracks tr
  join tst.ref r on r.schedule_track_id = tr.id) and b.s > (select planned_end_date from tst.ref)) > 0,
  'Cenário: há etapas de outros serviços previstas para depois da Revisão do Estrutural');

-- Prévia: atrasa "Alterações" em +10 dias úteis
select tst.login('lid@hq'); set role authenticated;
create temp table pv as select public.preview_task_change((select id from tst.ref), null, (select planned_duration_days from tst.ref) + 10) as j;
select tst.ok((select (j ->> 'delay_days')::int from pv) = 10, 'Prévia informa 10 dias úteis de atraso');
select tst.ok((select (j ->> 'other_services_count')::int from pv) >= 1, 'Prévia lista outros serviços do contrato');

select public.reschedule_task((select id from tst.ref), null, (select planned_duration_days from tst.ref) + 10, 'Cliente atrasou a resposta');
reset role; select tst.login('');

-- Toda etapa não iniciada do contrato (qualquer serviço, qualquer data) andou >= 10 dias úteis
select tst.ok(not exists (
  select 1 from tst.before b join public.project_tasks t on t.id = b.id
  where b.project_id = tst.pid('9001') and t.id <> (select id from tst.ref) and t.actual_start_date is null
    and t.status not in ('completed','cancelled') and b.s is not null
    and t.planned_start_date < public.add_business_days(b.s, 11, '00000000-0000-4000-8000-000000000101')),
  'Todas as etapas não iniciadas do contrato andaram 10 dias úteis');
select tst.ok((tst.task('9001', 'projeto_hidrossanitario', 'briefing_arq_apr_eng')).planned_start_date
              = public.add_business_days((select s from tst.before where id = (tst.task('9001', 'projeto_hidrossanitario', 'briefing_arq_apr_eng')).id), 11, '00000000-0000-4000-8000-000000000101'),
  'Até a etapa pronta para iniciar hoje (antes da etapa alterada) andou');
select tst.ok(exists (
  select 1 from tst.before b join public.project_tasks t on t.id = b.id
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  join public.project_services ps on ps.id = tr.project_service_id join public.services s on s.id = ps.service_id
  where b.project_id = tst.pid('9001') and s.code = 'projeto_eletrico' and t.code = 'planejamento'
    and t.planned_start_date = public.add_business_days(b.s, 11, '00000000-0000-4000-8000-000000000101')),
  'Elétrico (sem dependência do Estrutural) também foi empurrado 10 dias úteis');
select tst.ok((tst.task('9001', 'projeto_eletrico', 'briefing_arq_apr_eng')).start_not_before is not null
          and (tst.task('9001', 'projeto_eletrico', 'planejamento')).start_not_before is null
          and (tst.task('9001', 'projeto_estrutural', 'planejamento')).start_not_before is null,
  'Trava só na 1ª etapa de cada corrente; encadeadas seguem a dependência');
select tst.ok((tst.task('9001', 'projeto_arquitetonico', 'planejamento')).planned_start_date
              = (select s from tst.before where id = (tst.task('9001', 'projeto_arquitetonico', 'planejamento')).id),
  'Etapa em andamento não muda');
select tst.ok(not exists (
  select 1 from tst.before b join public.project_tasks t on t.id = b.id
  where b.project_id = tst.pid('9002') and (t.planned_start_date, t.planned_end_date) is distinct from (b.s, b.e)),
  'Outro contrato não muda');
select tst.ok((select (after ->> 'delay_days')::int from public.task_changes where task_id = (select id from tst.ref)
  order by created_at desc limit 1) = 10, 'Histórico registra os dias de atraso');

-- Antecipação não puxa as demais
create table tst.mid as select id, planned_start_date as s from public.project_tasks where project_id = tst.pid('9001');
grant select on tst.mid to authenticated;
select tst.login('lid@hq'); set role authenticated;
select tst.ok((public.preview_task_change((select id from tst.ref), null, 1) ->> 'delay_days')::int = 0, 'Antecipação: sem empurrão');
select public.reschedule_task((select id from tst.ref), null, 1, 'Equipe adiantou');
reset role;
select tst.ok(not exists (
  select 1 from tst.mid m join public.project_tasks t on t.id = m.id
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  where tr.id <> (select schedule_track_id from tst.ref) and t.planned_start_date < m.s),
  'Antecipação não adianta os outros serviços');
