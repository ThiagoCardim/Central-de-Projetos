-- Agenda de reuniões: disponibilidade, horários livres, agendamento, link público, cancelamento e Google.
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
create function tst.throws_like(stmt text, pat text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm not ilike '%' || pat || '%' then raise exception 'FALHOU (erro inesperado: %): %', sqlerrm, msg; end if;
    raise notice 'ok - % (bloqueado: %)', msg, sqlerrm; return;
  end;
  raise exception 'FALHOU (deveria bloquear): %', msg;
end $$;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "8201", "cliente": {"nome": "Iris", "email": "iris@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Iris", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','eng@hq','cs@hq','col@hq','out@hq','iris@x.com']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Ana Líder', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Bruno Engenheiro', 'eng@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab Arquiteta', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Fora do Projeto', 'out@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Iris Cliente', 'iris@x.com', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '8201' $$;
create function tst.local(t timestamptz) returns text language sql as $$ select to_char(t at time zone 'America/Sao_Paulo', 'HH24:MI') $$;
create function tst.slots(p_email text, p_kind text default 'alignment') returns timestamptz[] language plpgsql as $$
begin
  return array(select x::text::timestamptz from jsonb_array_elements_text(public.meeting_slots_portal(tst.pid(), tst.uid(p_email), p_kind) -> 'slots') x);
end $$;
create function tst.m(p_id uuid) returns public.meetings language sql security definer as $$ select * from public.meetings where id = p_id $$;
create function tst.notes(p_email text, p_kind text) returns int language sql security definer as $$
  select count(*)::int from public.notifications where recipient_profile_id = tst.uid(p_email) and kind = p_kind $$;
grant execute on all functions in schema tst to authenticated, service_role;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;
insert into public.project_team (project_id, user_id, project_role) values (tst.pid(), tst.uid('col@hq'), 'support');

-- Disponibilidade
select tst.login('col@hq'); set role authenticated;
select tst.throws_like($$select public.availability_save('[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"11:00","end":"13:00"}]', true)$$,
  'sobrepostas', 'Faixas sobrepostas recusadas');
select tst.throws_like($$select public.availability_save('[{"weekday":1,"start":"12:00","end":"09:00"}]', true)$$, 'início antes do fim', 'Fim antes do início recusado');
select public.availability_save((select jsonb_agg(jsonb_build_object('weekday', d, 'start', '09:00', 'end', '12:00')) from generate_series(1, 5) d), true);
select tst.ok(jsonb_array_length(public.my_availability() -> 'rules') = 5, 'Colaboradora define a semana (seg a sex, 9h às 12h)');
reset role;
select tst.login('iris@x.com'); set role authenticated;
select tst.ok((select string_agg(h ->> 'name', ',') from jsonb_array_elements(public.meeting_options(tst.pid()) -> 'hosts') h) = 'Colab Arquiteta',
  'Cliente vê só quem tem horários definidos');
select tst.ok(not (public.meeting_options(tst.pid()) ->> 'can_record')::boolean, 'Cliente não liga gravação');
create temp table s1 as select unnest(tst.slots('col@hq')) st;
reset role;
grant select on s1 to authenticated, service_role;
select tst.ok((select count(*) from s1) > 10, 'Há horários livres');
select tst.ok(not exists (select 1 from s1 where extract(dow from st at time zone 'America/Sao_Paulo') in (0, 6)), 'Nenhum horário no fim de semana');
select tst.ok(not exists (select 1 from s1 where tst.local(st) not in ('09:00', '09:30', '10:00', '10:30', '11:00')), 'Reunião de 1h cabe entre 9h e 12h');
select tst.ok((select min(st) from s1) >= now() + interval '24 hours', 'Cliente respeita 24h de antecedência');
create temp table pick as select min(st) st from s1 where tst.local(st) = '09:00';
grant select on pick to authenticated, service_role;

-- Cliente agenda
select tst.login('iris@x.com'); set role authenticated;
create temp table b1 as select public.meeting_book_portal(tst.pid(), tst.uid('col@hq'), 'alignment', (select st from pick), null, 'Quero falar sobre a cozinha', true) id;
grant select on b1 to authenticated, service_role;
select tst.throws_like(format('select public.meeting_book_portal(%L, %L, %L, %L, null, null, false)', tst.pid(), tst.uid('col@hq'), 'alignment', (select st from pick)),
  'não está mais disponível', 'Mesmo horário não é marcado duas vezes');
select tst.ok(not ((select st from pick) + interval '60 minutes' = any (tst.slots('col@hq'))) and ((select st from pick) + interval '90 minutes' = any (tst.slots('col@hq'))),
  'Intervalo de 15 min depois da reunião é respeitado');
select tst.ok(public.project_meetings(tst.pid()) -> 'meetings' -> 0 ->> 'state' = 'scheduled'
  and (public.project_meetings(tst.pid()) -> 'meetings' -> 0 ->> 'can_cancel')::boolean, 'Cliente vê a reunião e pode cancelar');
reset role;
select tst.ok(not (tst.m((select id from b1))).record and (tst.m((select id from b1))).transcribe and (tst.m((select id from b1))).booked_via = 'portal'
  and (tst.m((select id from b1))).ends_at = (select st from pick) + interval '60 minutes', 'Pedido do cliente: transcrição ligada, gravação desligada, 1 hora');
select tst.ok((select string_agg(x ->> 'email', ',' order by x ->> 'email') from jsonb_array_elements((tst.m((select id from b1))).attendees) x) = 'col@hq,iris@x.com',
  'Convidados: quem recebe e quem agendou');
select tst.ok(tst.notes('col@hq', 'meeting_booked') = 1, 'Colaboradora avisada da reunião');

-- Equipe agenda e liga a gravação; quem é de fora não
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.meeting_options(%L)', tst.pid()), 'Quem não é do projeto não agenda');
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.availability_save('[{"weekday":0,"start":"08:00","end":"18:00"},{"weekday":1,"start":"08:00","end":"18:00"},{"weekday":2,"start":"08:00","end":"18:00"},{"weekday":3,"start":"08:00","end":"18:00"},{"weekday":4,"start":"08:00","end":"18:00"},{"weekday":5,"start":"08:00","end":"18:00"},{"weekday":6,"start":"08:00","end":"18:00"}]', true);
create temp table b2 as select public.meeting_book_portal(tst.pid(), tst.uid('col@hq'), 'presentation', (select st from pick) + interval '90 minutes',
  (select id from public.project_tasks where project_id = tst.pid() and code = 'estudo_preliminar'), null, true) id;
grant select on b2 to authenticated, service_role;
reset role;
select tst.ok((tst.m((select id from b2))).record and (tst.m((select id from b2))).title like 'Apresentação · Estudo Preliminar%', 'Equipe agenda a apresentação de uma etapa, com gravação');
select tst.ok(exists (select 1 from jsonb_array_elements((tst.m((select id from b2))).attendees) x where x ->> 'email' = 'iris@x.com'), 'Agendada pela equipe: cliente que decide é convidado');
select tst.ok(tst.notes('iris@x.com', 'meeting_scheduled') = 1, 'Cliente avisado da reunião marcada pela equipe');

-- Bloqueios e ocupado do Google
select tst.login('col@hq'); set role authenticated;
create temp table blk as select public.availability_block_add(date_trunc('day', (select st from pick) + interval '1 day') + interval '3 hours',
  date_trunc('day', (select st from pick) + interval '1 day') + interval '27 hours', 'Folga') id;
reset role;
select tst.ok(not exists (select 1 from unnest((select array(select x::text::timestamptz from jsonb_array_elements_text(private.meeting_slots_portal(tst.pid(), tst.uid('col@hq'), 'alignment') -> 'slots') x))) u
                        where u between (select st from pick) + interval '20 hours' and (select st from pick) + interval '28 hours'), 'Bloqueio tira os horários do dia');
set role service_role;
select public.meeting_busy_put(tst.uid('col@hq'), ((select st from pick) at time zone 'America/Sao_Paulo')::date, ((select st from pick) at time zone 'America/Sao_Paulo')::date,
  jsonb_build_array(jsonb_build_object('s', (select st from pick) + interval '120 minutes', 'e', (select st from pick) + interval '150 minutes')));
reset role;
select tst.ok(not exists (select 1 from private.meeting_slots(tst.uid('col@hq'), 60, true) s where s.starts_at = (select st from pick) + interval '120 minutes'),
  'Compromisso no Google Calendar tira o horário');

-- Link público
select tst.login('col@hq'); set role authenticated;
create temp table lk as select public.meeting_link_create(tst.pid(), tst.uid('col@hq'), 'alignment', null, 7) j;
grant select on lk to authenticated, service_role;
select tst.ok(jsonb_array_length(public.project_meeting_links(tst.pid())) = 1, 'Link aparece no projeto');
reset role;
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.meeting_link_create(%L, %L, %L, null, 7)', tst.pid(), tst.uid('col@hq'), 'alignment'), 'Quem não é do projeto não cria link');
reset role;
select tst.login('iris@x.com'); set role authenticated;
select tst.throws(format('select public.meeting_link_create(%L, %L, %L, null, 7)', tst.pid(), tst.uid('col@hq'), 'alignment'), 'Cliente não cria link');
select tst.throws(format('select public.meeting_link_info(%L)', (select j ->> 'token' from lk)), 'Página pública só pela Edge Function');
reset role;
select tst.login(''); set role service_role;
select tst.ok(public.meeting_link_info((select j ->> 'token' from lk)) -> 'host' ->> 'name' = 'Colab Arquiteta'
  and public.meeting_link_info((select j ->> 'token' from lk)) -> 'host' ->> 'email' is null, 'Link mostra quem recebe, sem e-mail');
create temp table lslots as select x::text::timestamptz st from jsonb_array_elements_text(public.meeting_link_slots((select j ->> 'token' from lk)) -> 'slots') x;
select tst.throws_like(format('select public.meeting_link_book(%L, %L, %L, %L, null, null)', (select j ->> 'token' from lk), (select max(st) from lslots), 'X', 'x@y.com'),
  'nome', 'Nome obrigatório');
create temp table b3 as select public.meeting_link_book((select j ->> 'token' from lk), (select max(st) from lslots), 'Marcos Souza', 'Marcos@Email.com', '11 99999-0000', 'Sou o marido da Iris') id;
select tst.ok((tst.m((select id from b3))).booked_via = 'link' and (tst.m((select id from b3))).guest_email = 'marcos@email.com', 'Convidado agenda pelo link');
select tst.throws_like(format('select public.meeting_link_slots(%L)', (select j ->> 'token' from lk)), 'já foi usado', 'Link vale para uma reunião');
reset role;
update public.meeting_links set expires_at = now() - interval '1 minute', used_at = null where token = (select j ->> 'token' from lk);
set role service_role;
select tst.throws_like(format('select public.meeting_link_info(%L)', (select j ->> 'token' from lk)), 'expirou', 'Link vencido não abre');
reset role;

-- Cancelamento
select tst.login('out@hq'); set role authenticated;
select tst.throws(format('select public.meeting_cancel(%L, null)', (select id from b1)), 'Quem é de fora não cancela');
reset role;
select tst.login('iris@x.com'); set role authenticated;
select public.meeting_cancel((select id from b1), 'Imprevisto');
select tst.ok((select st from pick) = any (tst.slots('col@hq')), 'Horário cancelado volta a ficar livre');
reset role;
select tst.ok((tst.m((select id from b1))).status = 'cancelled' and tst.notes('col@hq', 'meeting_cancelled') = 1, 'Cancelada e quem recebe é avisado');

-- Transcrição e gravação no projeto
update public.meetings set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours', meet_space = 'spaces/abc' where id = (select id from b2);
select tst.login('col@hq'); set role authenticated;
select tst.ok(public.meetings_to_sync(tst.pid()) = jsonb_build_array((select id from b2)), 'Reunião encerrada entra na busca da transcrição');
reset role;
set role service_role;
select public.meeting_artifacts_put((select id from b2), 'https://docs.google.com/document/d/t1', 'https://drive.google.com/file/d/r1', 'done');
reset role;
select tst.login('col@hq'); set role authenticated;
select tst.ok((select m ->> 'transcript_url' from jsonb_array_elements(public.project_meetings(tst.pid()) -> 'meetings') m where (m ->> 'id')::uuid = (select id from b2))
  = 'https://docs.google.com/document/d/t1', 'Equipe vê o link da transcrição no projeto');
select tst.ok(public.meetings_to_sync(tst.pid()) = '[]'::jsonb, 'Com os arquivos, não busca de novo');
reset role;
select tst.login('iris@x.com'); set role authenticated;
select tst.ok((select m ->> 'transcript_url' from jsonb_array_elements(public.project_meetings(tst.pid()) -> 'meetings') m where (m ->> 'id')::uuid = (select id from b2)) is null,
  'Cliente não vê a transcrição sem a configuração');
reset role;
select tst.login('ga@hq'); set role authenticated;
select public.meeting_settings_save('00000000-0000-4000-8000-000000000001', '{"alignment_minutes":45,"presentation_minutes":90,"min_notice_hours":12,"horizon_days":21,"buffer_minutes":10,"slot_step_minutes":15,"share_with_client":true}');
select tst.throws_like($$select public.meeting_settings_save('00000000-0000-4000-8000-000000000001', '{"alignment_minutes":5,"presentation_minutes":90,"min_notice_hours":12,"horizon_days":21,"buffer_minutes":10,"slot_step_minutes":15}')$$,
  'fora do permitido', 'Configuração inválida recusada');
reset role;
select tst.login('iris@x.com'); set role authenticated;
select tst.ok((select m ->> 'transcript_url' from jsonb_array_elements(public.project_meetings(tst.pid()) -> 'meetings') m where (m ->> 'id')::uuid = (select id from b2)) is not null
  and (public.meeting_options(tst.pid()) -> 'kinds' -> 0 ->> 'minutes')::int = 45, 'Com a configuração, cliente vê a transcrição; duração nova vale');
reset role;

-- Conta Google
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.google_oauth_start(%L)', 'https://app'), 'Só o ADM Global conecta o Google');
select tst.throws('select public.google_account_get()', 'Token do Google não sai para o app');
reset role;
select tst.login('ga@hq'); set role authenticated;
create temp table stt as select public.google_oauth_start('https://portal.youcon.com.br/configuracoes') s;
grant select on stt to service_role;
reset role;
select tst.login(''); set role service_role;
select tst.ok(public.google_oauth_take((select s from stt)) ->> 'return_to' = 'https://portal.youcon.com.br/configuracoes', 'Retorno do Google valida o estado');
select tst.ok(public.google_oauth_take((select s from stt)) is null, 'Estado não é reaproveitado');
select public.google_account_save('Reunioes@youcon.com.br', 'rt-1', 'calendar meet drive', tst.uid('ga@hq'));
select tst.ok(public.google_account_get() ->> 'refresh_token' = 'rt-1' and public.google_account_get() ->> 'domain' = 'youcon.com.br', 'Conta central guardada');
reset role;
select tst.login('ga@hq'); set role authenticated;
select tst.ok(public.meeting_settings_get('00000000-0000-4000-8000-000000000001') -> 'google' ->> 'email' = 'reunioes@youcon.com.br'
  and not (public.meeting_settings_get('00000000-0000-4000-8000-000000000001') -> 'google' ? 'refresh_token'), 'ADM vê a conta conectada, sem o token');
select public.google_disconnect();
reset role;
set role service_role;
select tst.ok(public.google_account_get() is null, 'Desconectar apaga o token');
reset role;
