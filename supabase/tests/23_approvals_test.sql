-- Aprovações de projeto, trâmites no cronograma e comissões.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','apr@hq','adm@hq','fora@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Líder Ana', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Arq. Paula (aprovação)', 'apr@hq', 'collaborator', 'pj', null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Fora do projeto', 'fora@hq', 'collaborator', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Cliente Carla', 'cli@x', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9901", "cliente": {"nome": "Carla", "email": "carla@x.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Carla", "area_m2": "150"}, "servicos": "Projeto Arquitetônico, Aprovação", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
insert into public.client_contacts (client_id, profile_id, name)
select p.client_id, tst.uid('cli@x'), 'Cliente Carla' from public.projects p where p.external_id = '9901';
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '9901' $$;
create function tst.ps(p_code text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
  where ps.project_id = tst.pid() and s.code = p_code and ps.active $$;
create function tst.ty(p_code text) returns uuid language sql as $$ select id from public.approval_types where code = p_code $$;
create function tst.svc(p_code text) returns uuid language sql as $$ select id from public.services where code = p_code $$;
create function tst.proof(p_id uuid, p_type text default 'application/pdf') returns jsonb language sql as $$
  select jsonb_build_object('path', tst.pid()::text || '/' || p_id::text || '/comprovante.pdf', 'name', 'alvara.pdf', 'size', 1000, 'type', p_type) $$;
create function tst.a(p_code text) returns public.project_approvals language sql as $$
  select * from public.project_approvals where project_id = tst.pid() and approval_type_id = tst.ty(p_code) and status <> 'cancelled' $$;
grant execute on all functions in schema tst to authenticated;

-- Catálogo
select tst.ok((select count(*) from public.approval_types where active) = 10, '10 tipos de aprovação');
select tst.ok((select count(*) from public.services s join public.schedule_templates t on t.service_id = s.id and t.active
               where s.code like 'tramite%') = 8, '8 trâmites com cronograma padrão');
select tst.ok((select count(*) from public.template_tasks tt join public.schedule_templates t on t.id = tt.template_id and t.active
               join public.services s on s.id = t.service_id where s.code = 'tramite_cindacta') = 1, 'Trâmite tem uma etapa só');

-- Equipe: Ana lidera tudo; Paula cuida da Aprovação
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', tst.ps('aprovacao_projeto_legal'), 'user_id', tst.uid('apr@hq'))));
reset role;

-- Protocolos abertos
select tst.login('apr@hq'); set role authenticated;
create temp table b1 as select public.project_approval_board(tst.pid()) as j;
select tst.ok((select (j ->> 'can_register')::boolean from b1), 'Responsável pela aprovação pode registrar');
select tst.ok(not (select (j ->> 'can_include')::boolean from b1), 'Colaborador não inclui trâmite');
select tst.ok((select array_agg(x ->> 'type_code' order by x ->> 'type_code') from b1, jsonb_array_elements(j -> 'protocols') x) = array['condominio', 'prefeitura'],
  'Aprovação contratada abre Prefeitura e Condomínio');
select tst.ok((select jsonb_array_length(j -> 'tramites') from b1) = 8, 'Lista os 8 trâmites para incluir');
select tst.throws(format('select public.approval_include_tramite(%L, %L)', tst.pid(), tst.svc('tramite_terraplanagem')), 'Colaborador não inclui trâmite');
reset role;

select tst.login('fora@hq'); set role authenticated;
select tst.throws(format('select public.project_approval_board(%L)', tst.pid()), 'Quem não é do projeto não vê');
reset role;
select tst.login('cli@x'); set role authenticated;
select tst.throws(format('select public.project_approval_board(%L)', tst.pid()), 'Cliente não vê o controle de aprovações');
reset role;

-- Líder inclui o trâmite de Terraplanagem: nova trilha com uma etapa
select tst.login('lid@hq'); set role authenticated;
select public.approval_include_tramite(tst.pid(), tst.svc('tramite_terraplanagem'));
select tst.throws(format('select public.approval_include_tramite(%L, %L)', tst.pid(), tst.svc('tramite_terraplanagem')), 'Trâmite não entra duas vezes');
select tst.throws(format('select public.approval_include_tramite(%L, %L)', tst.pid(), tst.svc('projeto_estrutural')), 'Só serviços de aprovação entram como trâmite');
reset role;
select tst.ok((select count(*) from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
               where tr.project_service_id = tst.ps('tramite_terraplanagem') and t.client_visible) = 1, 'Trâmite aparece no cronograma (visível ao cliente)');
select tst.ok((select responsible_user_id from public.project_services where id = tst.ps('tramite_terraplanagem')) = tst.uid('lid@hq'),
  'Trâmite nasce com o líder de aprovação como responsável');

-- Valores padrão: só ADM
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.approval_rate_save(%L, %L, 500)', '00000000-0000-4000-8000-000000000001', tst.ty('prefeitura')), 'Líder não define valor');
select tst.ok(jsonb_array_length(public.approval_rates_list('00000000-0000-4000-8000-000000000001')) = 10, 'Líder de aprovação vê os valores');
reset role;
select tst.login('adm@hq'); set role authenticated;
select public.approval_rate_save('00000000-0000-4000-8000-000000000001', tst.ty('prefeitura'), 500);
select public.approval_rate_save('00000000-0000-4000-8000-000000000001', tst.ty('terraplanagem'), 250.5);
select tst.throws(format('select public.approval_rate_save(%L, %L, -1)', '00000000-0000-4000-8000-000000000001', tst.ty('pgr')), 'Valor negativo recusado');
reset role;

-- Paula registra a aprovação na Prefeitura
select tst.login('apr@hq'); set role authenticated;
create temp table ids as select gen_random_uuid() as pref, gen_random_uuid() as terra, gen_random_uuid() as dup;
grant select on ids to authenticated;
select tst.throws(format('select public.approval_register(%L, %L, %L, current_date, null, null, null)', (select pref from ids), tst.pid(), tst.ty('prefeitura')),
  'Sem comprovante não registra');
select tst.throws(format('select public.approval_register(%L, %L, %L, current_date, null, %L, null)', (select pref from ids), tst.pid(), tst.ty('prefeitura'),
  tst.proof((select pref from ids), 'text/plain')), 'Comprovante precisa ser PDF ou imagem');
select tst.throws(format('select public.approval_register(%L, %L, %L, current_date, null, %L, null)', (select pref from ids), tst.pid(), tst.ty('prefeitura'),
  tst.proof(gen_random_uuid())), 'Comprovante fora da pasta da aprovação');
select tst.throws(format('select public.approval_register(%L, %L, %L, current_date + 5, null, %L, null)', (select pref from ids), tst.pid(), tst.ty('prefeitura'),
  tst.proof((select pref from ids))), 'Data futura recusada');
select public.approval_register((select pref from ids), tst.pid(), tst.ty('prefeitura'), current_date, 'PMPC 1234/2026', tst.proof((select pref from ids)), null);
select tst.throws(format('select public.approval_register(%L, %L, %L, current_date, null, %L, null)', (select dup from ids), tst.pid(), tst.ty('prefeitura'),
  tst.proof((select dup from ids))), 'Mesma aprovação não é registrada duas vezes');
select tst.throws($$select public.approvals_list(null)$$, 'Colaborador não abre o controle de comissões');
select tst.throws(format('select public.approval_review(%L, true, null)', (select pref from ids)), 'Colaborador não confere');
select tst.ok((select x ->> 'amount' from jsonb_array_elements(public.project_approval_board(tst.pid()) -> 'approvals') x) is null,
  'Colaborador não vê o valor da comissão');
reset role;
select tst.ok((tst.a('prefeitura')).amount = 500, 'Valor padrão da Prefeitura aplicado');
select tst.ok((tst.a('prefeitura')).recipient_id = tst.uid('apr@hq'), 'Comissionado é o responsável pelo trâmite');
select tst.ok((tst.a('prefeitura')).status = 'awaiting_review', 'Aguardando conferência do líder');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('lid@hq') and kind = 'approval_review'),
  'Líder de aprovação é avisado');

-- Líder confere: recusa, Paula reenvia, líder aprova
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format('select public.approval_review(%L, false, null)', (select pref from ids)), 'Recusar exige motivo');
select public.approval_review((select pref from ids), false, 'Comprovante ilegível');
reset role;
select tst.ok((tst.a('prefeitura')).status = 'proof_rejected', 'Comprovante recusado');
select tst.ok(exists (select 1 from public.notifications where recipient_profile_id = tst.uid('apr@hq') and kind = 'approval_rejected'),
  'Quem registrou é avisado da recusa');
select tst.login('apr@hq'); set role authenticated;
select public.approval_register((select pref from ids), tst.pid(), tst.ty('prefeitura'), current_date, 'PMPC 1234/2026', tst.proof((select pref from ids)), 'Nova cópia');
reset role;
select tst.ok((tst.a('prefeitura')).status = 'awaiting_review', 'Reenvio volta para conferência');
select tst.login('lid@hq'); set role authenticated;
select public.approval_review((select pref from ids), true, null);
select tst.throws(format('select public.approval_set_status(%L, %L, null)', (select pref from ids), 'released'), 'Líder não libera comissão');
reset role;
select tst.ok((tst.a('prefeitura')).status = 'to_release', 'Conferida: a liberar');

-- Líder registra Terraplanagem: etapa do trâmite é concluída
select tst.login('lid@hq'); set role authenticated;
select public.approval_register((select terra from ids), tst.pid(), tst.ty('terraplanagem'), current_date, null, tst.proof((select terra from ids), 'image/jpeg'), null);
select tst.ok(jsonb_array_length(public.approvals_list(null)) = 2, 'Líder de aprovação vê as aprovações dos seus projetos');
reset role;
select tst.ok((select t.status from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
               where tr.project_service_id = tst.ps('tramite_terraplanagem')) = 'completed', 'Etapa do trâmite concluída no cronograma');
select tst.ok((tst.a('terraplanagem')).amount = 250.50 and (tst.a('terraplanagem')).recipient_id = tst.uid('lid@hq'), 'Terraplanagem com valor e comissionado');

-- ADM libera e paga
select tst.login('adm@hq'); set role authenticated;
select tst.throws(format('select public.approval_set_status(%L, %L, null)', (select terra from ids), 'released'), 'Não libera antes da conferência');
select public.approval_update((select pref from ids), 650, null);
select public.approval_set_status((select pref from ids), 'released', null);
select public.approval_set_status((select pref from ids), 'paid', null);
select tst.throws(format('select public.approval_update(%L, 1, null)', (select pref from ids)), 'Comissão paga não muda de valor');
select tst.throws(format('select public.approval_set_status(%L, %L, null)', (select pref from ids), 'cancelled'), 'Paga não é cancelada');
select tst.throws(format('select public.approval_set_status(%L, %L, null)', (select terra from ids), 'cancelled'), 'Cancelar exige motivo');
select public.approval_set_status((select terra from ids), 'cancelled', 'Registrado por engano');
select tst.ok(jsonb_array_length(public.approvals_list(null)) = 1, 'Cancelada sai da lista');
reset role;
select tst.ok((tst.a('prefeitura')).status = 'paid' and (tst.a('prefeitura')).amount = 650 and (tst.a('prefeitura')).paid_at is not null, 'Comissão paga com valor ajustado');

-- Permissões da interface
select tst.login('lid@hq'); set role authenticated;
select tst.ok((public.my_permissions() ->> 'can_view_approvals')::boolean and not (public.my_permissions() ->> 'can_admin_approvals')::boolean, 'Líder de aprovação vê a aba, sem administrar');
reset role;
select tst.login('apr@hq'); set role authenticated;
select tst.ok(not (public.my_permissions() ->> 'can_view_approvals')::boolean, 'Colaborador não vê a aba de aprovações');
reset role;
select tst.login('adm@hq'); set role authenticated;
select tst.ok((public.my_permissions() ->> 'can_admin_approvals')::boolean, 'ADM administra comissões');
reset role;
