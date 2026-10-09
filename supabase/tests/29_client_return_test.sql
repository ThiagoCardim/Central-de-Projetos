-- Prazo de retorno do cliente: espera, empurrão diário, retorno com data real, abono.
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
select public.ingest_crm_webhook('pipefy', '{"card_id": "7701", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Iris", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','eng@hq','adm@hq','cs@hq','col@hq','out@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Ana Líder', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Bruno Engenheiro', 'eng@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab Arquiteta', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Fora do Projeto', 'out@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Iris Cliente', 'cli@x', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Iris Cliente' from public.projects p where p.external_id = '7701';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '7701' $$;
create function tst.ps(p_code text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id where ps.project_id = tst.pid() and s.code = p_code $$;
create function tst.item(p_code text) returns jsonb language sql as $$
  select i from jsonb_array_elements(public.project_deliveries(tst.pid()) -> 'items') i where (i ->> 'project_service_id')::uuid = tst.ps(p_code) $$;
create function tst.draft(p_code text) returns uuid language sql security definer as $$
  select v.id from public.delivery_versions v join public.project_deliveries d on d.id = v.delivery_id
  where d.project_service_id = tst.ps(p_code) and v.published_at is null and v.archived_at is null $$;
-- Publica uma versão com um link (como a equipe faria)
create function tst.publish(p_code text, p_kind text) returns uuid language plpgsql as $$
declare v uuid;
begin
  v := public.delivery_version_start(tst.pid(), tst.ps(p_code), p_kind, null, 'Segue a versão', null);
  perform public.delivery_file_add(v, 'link', 'Pranchas', null, null, null, 'https://drive.google.com/x/' || v);
  perform public.delivery_version_publish(v);
  return v;
end $$;
create function tst.notes(p_email text, p_kind text) returns int language sql security definer as $$
  select count(*)::int from public.notifications where recipient_profile_id = tst.uid(p_email) and kind = p_kind $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
-- A colaboradora é a responsável pelo Estudo Preliminar
select public.set_task_responsible(pt.id, tst.uid('col@hq'))
  from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
 where tr.project_service_id = tst.ps('projeto_arquitetonico') and pt.code = 'estudo_preliminar';
reset role;


-- Etapa não iniciada de outro serviço, para medir o empurrão
create function tst.probe() returns uuid language sql security definer as $$
  select pt.id from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
  where tr.project_service_id = tst.ps('projeto_estrutural') and pt.actual_start_date is null and pt.planned_start_date is not null
  order by pt.sequence desc limit 1 $$;
create function tst.start_of(p uuid) returns date language sql security definer as $$ select planned_start_date from public.project_tasks where id = p $$;
create function tst.cal() returns uuid language sql security definer as $$ select private.client_wait_cal(tst.pid()) $$;
create function tst.wait(p_source text) returns public.client_waits language sql security definer as $$
  select * from public.client_waits where project_id = tst.pid() and source = p_source order by created_at desc limit 1 $$;
create function tst.pushes() returns int language sql security definer as $$
  select count(*)::int from public.client_wait_pushes where project_id = tst.pid() and refunded_at is null $$;
grant execute on all functions in schema tst to authenticated;

-- Publicar a apresentação abre a espera (2 dias úteis)
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'presentation');
reset role;
select tst.ok((tst.wait('delivery')).due_on = public.add_business_days(private.today_br() + 1, 2, tst.cal()), 'Espera aberta com prazo de 2 dias úteis');
select tst.login('cli@x'); set role authenticated;
select tst.ok(jsonb_array_length(public.my_client_waits()) = 1 and public.my_client_waits() -> 0 ->> 'state' = 'open', 'Cliente vê que aguardamos o retorno dele');
select tst.ok((public.my_client_waits() -> 0 ->> 'can_return')::boolean is false, 'Cliente não registra retorno por conta própria');
reset role;

-- Três dias úteis depois do prazo: dois dias completos de atraso
create temp table base as select tst.probe() id, tst.start_of(tst.probe()) s,
  public.add_business_days((tst.wait('delivery')).due_on + 1, 3, tst.cal()) fake;
select tst.ok(private.client_wait_run((select fake from base)) = 2, 'Dois dias de atraso empurram o projeto');
select tst.ok(private.client_wait_run((select fake from base)) = 0, 'Rotina não empurra o mesmo dia duas vezes');
select tst.ok(public.business_days_between((select s from base) + 1, tst.start_of((select id from base)), tst.cal()) = 2,
  'Etapa não iniciada de outro serviço andou 2 dias úteis');
select tst.ok((select count(*) from public.task_changes where project_id = tst.pid() and reason like 'Aguardando aprovação ou retorno do cliente%') = 2,
  'Cada dia fica no histórico com o motivo do cliente');
select tst.ok((select count(*) from public.notifications where recipient_profile_id = tst.uid('cli@x') and kind = 'client_wait_late') = 1
  and (select count(*) from public.notifications where recipient_role = 'customer_success' and kind = 'client_wait_late') >= 1, 'Cliente e CS avisados do atraso');
select tst.login('cli@x'); set role authenticated;
select tst.ok(exists (select 1 from jsonb_array_elements(public.client_schedule_changes(tst.pid(), 50)) c where c ->> 'reason' = 'Aguardando aprovação ou retorno do cliente'),
  'Cliente vê o ajuste no histórico de prazos');
select tst.ok((public.my_client_waits() -> 0 ->> 'late_days')::int = 2, 'Cliente vê os dias adiados');
reset role;

-- Quem registra o retorno
select tst.login('cs@hq'); set role authenticated;
select tst.throws(format('select public.client_wait_return(%L, null, null)', (tst.wait('delivery')).id), 'CS não registra retorno');
reset role;
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.client_wait_return(%L, null, null)', (tst.wait('delivery')).id), 'Quem não é do projeto não registra');
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.throws(format('select public.client_wait_return(%L, %L, null)', (tst.wait('delivery')).id, private.today_br() + 1), 'Data de retorno no futuro recusada');
select tst.ok((public.client_wait_return((tst.wait('delivery')).id, (tst.wait('delivery')).started_on, 'Respondeu pelo WhatsApp') ->> 'refunded_days')::int = 2,
  'Responsável registra o retorno com a data real e os dias voltam');
reset role;
select tst.ok(tst.start_of((select id from base)) = (select s from base) and tst.pushes() = 0, 'Cronograma voltou ao que era');
select tst.ok((tst.wait('delivery')).closed_at is not null and (tst.wait('delivery')).close_source = 'team', 'Espera encerrada pela equipe');

-- Etapa marcada como "Aguardando cliente" pelo líder
create temp table tk as select pt.id from public.project_tasks pt join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
  where tr.project_service_id = tst.ps('projeto_arquitetonico') order by pt.sequence limit 1;
grant select on tk to authenticated;
select tst.login('lid@hq'); set role authenticated;
select public.set_task_status((select id from tk), 'waiting_client', 'Aguardando o briefing preenchido');
reset role;
select tst.ok((tst.wait('task')).task_id = (select id from tk) and (tst.wait('task')).closed_at is null, 'Status "Aguardando cliente" abre a espera');
select tst.ok(private.client_wait_run(public.add_business_days((tst.wait('task')).due_on + 1, 4, tst.cal())) = 3, 'Três dias de atraso pela etapa');
select tst.ok(public.business_days_between((select s from base) + 1, tst.start_of((select id from base)), tst.cal()) = 3, 'Projeto empurrado 3 dias úteis');

-- Abono
select tst.login('eng@hq'); set role authenticated;
select tst.throws(format('select public.client_wait_waive(%L, %L, %L)', (tst.wait('task')).id, (tst.wait('task')).due_on + 30, 'Cliente viajando'),
  'Líder de outra área não abona');
reset role;
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.client_wait_waive(%L, %L, %L)', (tst.wait('task')).id, (tst.wait('task')).due_on + 30, 'x'), 'Abono exige motivo');
select tst.ok((public.client_wait_waive((tst.wait('task')).id, public.add_business_days((tst.wait('task')).due_on + 1, 2, tst.cal()), 'Cliente viajando, combinado por telefone')
  ->> 'refunded_days')::int = 2, 'Líder da área abona 2 dias e eles voltam');
reset role;
select tst.ok(public.business_days_between((select s from base) + 1, tst.start_of((select id from base)), tst.cal()) = 1 and tst.pushes() = 1, 'Fica só o dia não abonado');

-- Sair de "Aguardando cliente" encerra a espera
select tst.login('lid@hq'); set role authenticated;
select public.set_task_status((select id from tk), 'in_progress', null);
reset role;
select tst.ok((tst.wait('task')).closed_at is not null and (tst.wait('task')).close_source = 'status', 'Etapa retomada encerra a espera');

-- Aprovação pelo portal encerra a espera da entrega
select tst.login('cli@x'); set role authenticated;
select public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Ajuste'], null);
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'revision');
reset role;
select tst.ok((tst.wait('delivery')).closed_at is null, 'Nova versão publicada abre nova espera');
select tst.login('cli@x'); set role authenticated;
select public.delivery_approve(tst.pid(), tst.ps('projeto_arquitetonico'), null);
reset role;
select tst.ok((tst.wait('delivery')).close_source = 'portal', 'Aprovação do cliente encerra a espera');

-- Prazo configurável por unidade
select tst.login('col@hq'); set role authenticated;
select tst.throws($$select public.client_wait_settings_save('00000000-0000-4000-8000-000000000001', true, 3)$$, 'Colaborador não altera o prazo');
reset role;
select tst.login('adm@hq'); set role authenticated;
select public.client_wait_settings_save('00000000-0000-4000-8000-000000000001', true, 3);
select tst.ok((public.client_wait_settings_get('00000000-0000-4000-8000-000000000001') ->> 'days')::int = 3, 'Prazo da unidade alterado para 3 dias');
select public.set_task_status((select id from tk), 'waiting_client', 'Aguardando documentos');
select tst.ok((tst.wait('task')).due_on = public.add_business_days(private.today_br() + 1, 3, tst.cal()), 'Nova espera usa 3 dias úteis');
reset role;
select tst.login('cs@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.client_waits_overview()) = 1, 'CS vê as esperas abertas');
reset role;
select tst.login('lid@hq'); set role authenticated;
select tst.ok((public.project_client_waits(tst.pid()) ->> 'total_late_days')::int = 0 and jsonb_array_length(public.project_client_waits(tst.pid()) -> 'waits') >= 3, 'Projeto lista as esperas; dias posteriores ao retorno não contam');
reset role;
