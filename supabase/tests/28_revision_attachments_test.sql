-- Anexos no pedido de revisão (prints, referências, inspirações).
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


select tst.login('col@hq'); set role authenticated;
select tst.publish('projeto_arquitetonico', 'presentation');
reset role;

create temp table rq as select gen_random_uuid() id;
grant select on rq to authenticated;

-- Quem pode subir anexos antes do registro
select tst.login('cli@x'); set role authenticated;
select tst.ok(private.delivery_req_file_writable(tst.pid()::text, (select id::text from rq)), 'Cliente pode anexar ao pedido');
select tst.ok(not private.delivery_req_file_writable(tst.pid()::text, 'nao-e-uuid'), 'Pasta inválida recusada');
reset role;
select tst.login('out@hq'); set role authenticated;
select tst.ok(not private.delivery_req_file_writable(tst.pid()::text, (select id::text from rq)), 'Quem não está no projeto não anexa');
reset role;

-- Registro com anexos
select tst.login('cli@x'); set role authenticated;
select tst.throws(format('select public.delivery_request_revision(%L, %L, %L, null, %L, %L::jsonb)', tst.pid(), tst.ps('projeto_arquitetonico'),
  '{"Trocar a escada"}', (select id from rq), jsonb_build_array(jsonb_build_object('name', 'x.png', 'path', 'outro/req/x/x.png'))::text), 'Anexo fora da pasta do pedido');
select tst.ok(public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Trocar a escada por uma helicoidal'], 'Seguem referências',
  (select id from rq), jsonb_build_array(
    jsonb_build_object('name', 'Print da planta.png', 'path', tst.pid() || '/req/' || (select id from rq) || '/a.png', 'mime', 'image/png', 'size', 120000),
    jsonb_build_object('name', 'Inspiração escada.jpg', 'path', tst.pid() || '/req/' || (select id from rq) || '/b.jpg', 'mime', 'image/jpeg', 'size', 340000))) = 1,
  'Revisão 1 registrada com 2 anexos');
select tst.ok(jsonb_array_length(tst.item('projeto_arquitetonico') -> 'open_request' -> 'files') = 2
  and tst.item('projeto_arquitetonico') -> 'open_request' -> 'files' -> 0 ->> 'name' = 'Print da planta.png', 'Cliente vê os anexos do pedido');
select tst.ok(not private.delivery_req_file_writable(tst.pid()::text, (select id::text from rq)), 'Pedido registrado não recebe novos anexos');
select tst.ok(private.delivery_req_file_readable(tst.pid()::text), 'Cliente abre os anexos');
reset role;
select tst.ok((select body from public.notifications where recipient_profile_id = tst.uid('col@hq') and kind = 'delivery_revision' limit 1) like '%e 2 anexos%',
  'Aviso da revisão menciona os anexos');

select tst.login('col@hq'); set role authenticated;
select tst.ok(jsonb_array_length(tst.item('projeto_arquitetonico') -> 'requests' -> 0 -> 'files') = 2, 'Equipe vê os anexos no histórico');
select tst.ok(private.delivery_req_file_readable(tst.pid()::text), 'Equipe abre os anexos');
select tst.publish('projeto_arquitetonico', 'revision');
-- Equipe registra em nome do cliente, com anexo
select tst.ok(public.delivery_request_revision(tst.pid(), tst.ps('projeto_arquitetonico'), array['Print enviado por WhatsApp'], null, gen_random_uuid(), '[]'::jsonb) = 2,
  'Equipe registra revisão sem anexo pela versão nova');
reset role;
select tst.login('out@hq'); set role authenticated;
select tst.ok(not private.delivery_req_file_readable(tst.pid()::text), 'Quem não está no projeto não abre os anexos');
reset role;

-- Conferência final
select tst.ok((select count(*) from public.delivery_request_files) = 2, 'Anexos gravados uma vez só');
