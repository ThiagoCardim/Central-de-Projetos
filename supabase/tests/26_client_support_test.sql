-- "Preciso de ajuda": cliente → WhatsApp do líder certo; CS acompanha.
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
select public.ingest_crm_webhook('pipefy', '{"card_id": "9981", "cliente": {"nome": "Hugo", "email": "hugo@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Hugo", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Projeto Estrutural", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','eng@hq','adm@hq','cs@hq','col@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Ana Líder', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Bruno Engenheiro', 'eng@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Carla CS', 'cs@hq', 'customer_success', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Colab', 'col@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Hugo Cliente', 'cli@x', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Hugo Cliente' from public.projects p where p.external_id = '9981';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9981' $$;
create function tst.cat(p_target text) returns uuid language sql as $$ select id from public.support_categories where target = p_target order by sort_order limit 1 $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('eng@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;

-- Configuração
select tst.login('adm@hq'); set role authenticated;
select tst.ok(public.set_person_whatsapp(tst.uid('eng@hq'), '(35) 99999-1111') = '5535999991111', 'WhatsApp normalizado com DDI 55');
select tst.throws(format('select public.set_person_whatsapp(%L, %L)', tst.uid('eng@hq'), '1234'), 'Número inválido recusado');
select tst.throws(format('select public.set_person_whatsapp(%L, %L)', tst.uid('cli@x'), '35999990000'), 'Cliente não tem WhatsApp de atendimento');
select tst.ok(jsonb_array_length(public.support_settings_get('00000000-0000-4000-8000-000000000001') -> 'categories') = 4, '4 assuntos padrão');
select tst.throws($$select public.support_category_save(null, 'Financeiro', null, 'cs', true)$$, 'Só o ADM Global edita os assuntos');
reset role;
select tst.login('cli@x'); set role authenticated;
select tst.throws(format('select public.set_person_whatsapp(%L, %L)', tst.uid('eng@hq'), '35999990000'), 'Cliente não configura WhatsApp');
reset role;

-- Cliente pede ajuda
select tst.login('cli@x'); set role authenticated;
create temp table o as select public.support_options() as j;
select tst.ok((select jsonb_array_length(j -> 'categories') from o) = 4 and (select jsonb_array_length(j -> 'projects') from o) = 1, 'Cliente vê assuntos e o projeto');
create temp table r1 as select public.support_open(tst.pid(), tst.cat('engineering'), 'Dúvida sobre a laje') as j;
select tst.ok((select j ->> 'contact_name' from r1) = 'Bruno Engenheiro', 'Engenharia vai para o líder de Engenharia do projeto');
select tst.ok((select j ->> 'url' from r1) like 'https://wa.me/5535999991111?text=Ol%C3%A1%2C%20Bruno%21%20Aqui%20%C3%A9%20Hugo%2C%20do%20projeto%20Casa%20Hugo.%20Estou%20precisando%20de%20uma%20ajuda%20sobre%20engenharia.%20D%C3%BAvida%20sobre%20a%20laje.%20Consegue%20me%20ajudar%3F', 'Link do WhatsApp com a mensagem pronta');
create temp table r2 as select public.support_open(tst.pid(), tst.cat('architecture'), null) as j;
select tst.ok((select j ->> 'contact_name' from r2) = 'Ana Líder' and not (select (j ->> 'has_whatsapp')::boolean from r2) and (select j ->> 'url' from r2) is null,
  'Líder sem WhatsApp: registra mesmo assim, sem link');
select tst.throws(format('select public.support_open(%L, %L, null)', tst.pid(), gen_random_uuid()), 'Assunto inválido');
reset role;

select tst.login('adm@hq'); set role authenticated;
select public.support_settings_save('00000000-0000-4000-8000-000000000001', '35 3333-4444', 'Oi {lider}, sou {cliente} ({projeto}). Assunto: {assunto}. {mensagem}');
reset role;
select tst.login('cli@x'); set role authenticated;
create temp table r3 as select public.support_open(tst.pid(), tst.cat('architecture'), null) as j;
select tst.ok((select j ->> 'contact_name' from r3) = 'Customer Success' and (select j ->> 'url' from r3) like 'https://wa.me/553533334444?text=Oi%20equipe%20YouCon%2C%20sou%20Hugo%20%28Casa%20Hugo%29.%20Assunto%3A%20projeto%20arquitet%C3%B4nico%20e%20interiores.',
  'Sem WhatsApp do líder, cai no CS da unidade com a mensagem configurada');
create temp table r4 as select public.support_open(tst.pid(), tst.cat('cs'), 'Quando sai o estudo?') as j;
select tst.ok((select j ->> 'contact_name' from r4) = 'Customer Success', 'Prazos e andamento vai para o CS');
reset role;
select tst.ok(exists (select 1 from public.notifications where kind = 'support_opened' and recipient_role = 'customer_success'), 'CS é avisado do atendimento');
select tst.ok(exists (select 1 from public.notifications where kind = 'support_leader' and recipient_profile_id = tst.uid('eng@hq')), 'Líder é avisado que o cliente vai chamar');

-- Acompanhamento do CS
select tst.login('col@hq'); set role authenticated;
select tst.throws($$select public.support_tickets_list()$$, 'Colaborador não vê os atendimentos');
reset role;
select tst.login('cs@hq'); set role authenticated;
create temp table l as select public.support_tickets_list() as j;
select tst.ok((select jsonb_array_length(j) from l) = 4, 'CS vê os 4 atendimentos');
select public.support_ticket_update((select (j -> 0 ->> 'id')::uuid from l), 'resolved', 'Cliente confirmou que foi resolvido');
reset role;
select tst.ok((select count(*) from public.support_tickets where status = 'resolved' and cs_note like 'Cliente confirmou%' and closed_by = tst.uid('cs@hq')) = 1,
  'CS marca como resolvido, com observação');
