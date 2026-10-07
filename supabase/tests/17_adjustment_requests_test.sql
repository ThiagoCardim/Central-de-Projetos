-- Pedido de ajuste entre setores: solicitação, aprovação pelo líder da área, cronograma e responsável.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['larq@hq','leng@hq','arq@hq','arq2@hq','est@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder Arquitetura', 'larq@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Líder Engenharia', 'leng@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta Dois', 'arq2@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Eng. Estrutural', 'est@hq', 'collaborator', 'pj');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9401", "cliente": {"nome": "Nina", "email": "nina@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Nina", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural, Projeto Elétrico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9401' $$;
create function tst.ps(p_service text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id where ps.project_id = tst.pid() and s.code = p_service $$;
create function tst.task(p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  where tr.project_service_id = tst.ps(p_service) and t.code = p_code $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('larq@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('larq@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('leng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('larq@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('arq@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_estrutural'), 'user_id', tst.uid('est@hq'))));
select public.set_task_status((tst.task('projeto_arquitetonico', c)).id, s::public.task_status)
from (values ('planejamento','in_progress',1),('planejamento','completed',2),('envio_briefing','in_progress',3),('envio_briefing','completed',4),
             ('estudo_preliminar','in_progress',5),('estudo_preliminar','completed',6)) v(c, s, o) order by o;
reset role;

select tst.ok((select count(*) from public.adjustment_complexities) = 3, 'Tabela de prazos: simples, média e complexa');

create table tst.before as select id, planned_start_date as s from public.project_tasks where project_id = tst.pid();
grant select on tst.before to authenticated;

-- Engenheiro do Estrutural pede ajuste no Estudo Preliminar (Arquitetura)
select tst.login('est@hq'); set role authenticated;
select tst.throws(format('select public.adjustment_create(%L, %L, %L)', (tst.task('projeto_arquitetonico', 'alteracoes')).id, 'simple', 'Ajustar pilar'),
  'Não pede ajuste em etapa que nem começou');
select public.adjustment_create((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'medium',
  'Pilar central conflita com a laje; ajustar o vão da sala', null, tst.ps('projeto_estrutural'));
select tst.throws(format('select public.adjustment_create(%L, %L, %L)', (tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'simple', 'De novo o mesmo'),
  'Um pedido pendente por etapa');
select tst.ok((select (x ->> 'requested_days')::int from jsonb_array_elements(public.project_adjustments(tst.pid())) x) = 7,
  'Prazo sugerido pela complexidade média (7 dias úteis)');
select tst.ok(not ((public.project_adjustments(tst.pid()) -> 0 ->> 'can_decide')::boolean), 'Quem pede não aprova');
reset role;

select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('larq@hq') and title = 'Ajuste aguardando sua aprovação'),
  'Líder da Arquitetura (setor requisitado) é avisado');
select tst.ok(not exists (select 1 from public.notifications where recipient_profile_id = tst.uid('leng@hq') and title = 'Ajuste aguardando sua aprovação'),
  'Líder da Engenharia não é quem aprova');

-- Líder da Engenharia não pode aprovar
select tst.login('leng@hq'); set role authenticated;
select tst.throws(format('select public.adjustment_decide(%L, true, null, null, %L)', (select id from public.adjustment_requests limit 1), tst.uid('arq2@hq')),
  'Só o líder do setor requisitado aprova');
reset role;

-- Líder da Arquitetura aprova com 5 dias e coloca a Arquiteta Dois
select tst.login('larq@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.my_pending_adjustments()) = 1, 'Pedido aparece em "aguardando sua aprovação"');
select tst.throws(format('select public.adjustment_decide(%L, true)', (select id from public.adjustment_requests limit 1)),
  'Aprovar exige escolher o colaborador');
select public.adjustment_decide((select id from public.adjustment_requests limit 1), true, 'Ok, prioridade', 5, tst.uid('arq2@hq'));
reset role; select tst.login('');

select tst.ok((select status from public.adjustment_requests limit 1) = 'approved', 'Pedido aprovado');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).status = 'in_progress'
          and (tst.task('projeto_arquitetonico', 'estudo_preliminar')).responsible_user_id = tst.uid('arq2@hq'),
  'Etapa reaberta com o colaborador escolhido');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).planned_duration_days = 5, 'Prazo do ajuste aprovado (5 dias úteis)');
select tst.ok((tst.task('projeto_eletrico', 'planejamento')).planned_start_date > (select s from tst.before where id = (tst.task('projeto_eletrico', 'planejamento')).id),
  'Cronograma dos outros serviços do contrato andou');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('est@hq') and title = 'Pedido de ajuste aprovado'),
  'Quem pediu é avisado da aprovação');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('arq2@hq') and title = 'Etapa reaberta'),
  'Colaborador é avisado para executar');

-- Etapa em andamento: aprovação acrescenta dias
select tst.login('est@hq'); set role authenticated;
select public.adjustment_create((tst.task('projeto_arquitetonico', 'estudo_preliminar')).id, 'simple', 'Mais um detalhe na escada');
reset role;
select tst.login('larq@hq'); set role authenticated;
select public.adjustment_decide((select id from public.adjustment_requests where status = 'pending'), true, null, null, tst.uid('arq2@hq'));
reset role; select tst.login('');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).planned_duration_days = 8, 'Em andamento: +3 dias (simples) na duração');

-- Recusa exige justificativa e avisa quem pediu
select tst.login('est@hq'); set role authenticated;
select public.adjustment_create((tst.task('projeto_arquitetonico', 'envio_briefing')).id, 'complex', 'Rever todo o programa de necessidades');
reset role;
select tst.login('larq@hq'); set role authenticated;
select tst.throws(format('select public.adjustment_decide(%L, false)', (select id from public.adjustment_requests where status = 'pending')),
  'Recusa exige justificativa');
select public.adjustment_decide((select id from public.adjustment_requests where status = 'pending'), false, 'Programa já aprovado pelo cliente');
reset role; select tst.login('');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('est@hq') and title = 'Pedido de ajuste recusado'),
  'Quem pediu é avisado da recusa');
select tst.ok((tst.task('projeto_arquitetonico', 'envio_briefing')).status = 'completed', 'Recusado: etapa continua concluída');

-- Ajuste interno não aparece para o cliente (motivo interno por padrão)
select tst.ok(not exists (select 1 from public.task_changes c join public.schedule_change_reasons r on r.id = c.reason_id
                          where r.client_visible and c.project_id = tst.pid()), 'Ajustes internos não vão para a visão do cliente');
