-- =============================================================================
-- Testes de segurança: isolamento multi-tenant, RBAC, RLS, auditoria e guardas.
-- Executa como superusuário para montar o cenário e alterna para o papel
-- `authenticated` simulando o JWT de cada perfil.
-- =============================================================================
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tst;
grant usage on schema tst to authenticated;

create function tst.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALHOU: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

create function tst.throws(stmt text, msg text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok - % (bloqueado: %)', msg, sqlerrm;
    return;
  end;
  raise exception 'FALHOU (deveria bloquear): %', msg;
end $$;

-- Identidade simulada: define o "sub" do JWT pelo e-mail do perfil.
create function tst.login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',
    coalesce((select auth_user_id::text from public.profiles where email = p_email), ''), false);
end $$;
grant execute on all functions in schema tst to authenticated;

-- -----------------------------------------------------------------------------
-- Cenário
-- -----------------------------------------------------------------------------
insert into public.tenants (id, name, type, parent_tenant_id, slug) values
  ('00000000-0000-4000-8000-00000000000a', 'Franquia A', 'franquia', '00000000-0000-4000-8000-000000000001', 'franquia-a'),
  ('00000000-0000-4000-8000-00000000000b', 'Franquia B', 'franquia', '00000000-0000-4000-8000-000000000001', 'franquia-b');

insert into auth.users (id, email)
select gen_random_uuid(), e from unnest(array[
  'global@hq','admin@a','lider@a','clt@a','pj@a','cliente@a','admin@b','lider@b','inativo@a']) e;

insert into public.profiles (auth_user_id, tenant_id, name, email, role, employment_type, client_type, status)
select u.id, t.tid, t.name, t.email, t.role::public.user_role, t.emp::public.employment_type, t.ct::public.client_type, t.st::public.record_status
from (values
  ('global@hq', '00000000-0000-4000-8000-000000000001'::uuid, 'Ana Global',    'global_admin', null, null, 'ativo'),
  ('admin@a',   '00000000-0000-4000-8000-00000000000a'::uuid, 'Bruno Adm A',   'unit_admin',   'clt', null, 'ativo'),
  ('lider@a',   '00000000-0000-4000-8000-00000000000a'::uuid, 'Carla Líder A', 'leader',       'clt', null, 'ativo'),
  ('clt@a',     '00000000-0000-4000-8000-00000000000a'::uuid, 'Davi CLT',      'collaborator', 'clt', null, 'ativo'),
  ('pj@a',      '00000000-0000-4000-8000-00000000000a'::uuid, 'Eva PJ',        'collaborator', 'pj',  null, 'ativo'),
  ('cliente@a', '00000000-0000-4000-8000-00000000000a'::uuid, 'Fábio Cliente', 'client',       null,  'b2c', 'ativo'),
  ('admin@b',   '00000000-0000-4000-8000-00000000000b'::uuid, 'Gabi Adm B',    'unit_admin',   null,  null, 'ativo'),
  ('lider@b',   '00000000-0000-4000-8000-00000000000b'::uuid, 'Hugo Líder B',  'leader',       null,  null, 'ativo'),
  ('inativo@a', '00000000-0000-4000-8000-00000000000a'::uuid, 'Igor Inativo',  'collaborator', 'clt', null, 'inativo')
) t(email, tid, name, role, emp, ct, st)
join auth.users u on u.email = t.email;

insert into public.clients (id, tenant_id, name, client_type) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000a', 'Cliente Residencial A', 'b2c'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-00000000000b', 'Cliente Corporativo B', 'b2b'),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-000000000001', 'Cliente HQ',            'b2c');
insert into public.client_contacts (client_id, profile_id, name, is_primary)
select '00000000-0000-4000-8000-0000000000c1', id, name, true from public.profiles where email = 'cliente@a';

insert into public.projects (id, client_id, name, client_type, origin_tenant_id, commercial_tenant_id, delivery_tenant_id, status) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1', 'Casa A',     'b2c', null,
   '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'in_progress'),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2', 'Galpão B',   'b2b', null,
   '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000b', 'in_progress'),
  -- Vendido pela franqueadora, executado pela Franquia A
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000c3', 'Loja HQ→A',  'b2c', '00000000-0000-4000-8000-00000000000b',
   '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a', 'awaiting_team_assignment');

insert into public.project_team (project_id, user_id, project_role, employment_type)
select '00000000-0000-4000-8000-0000000000a1', id, 'architecture', 'clt' from public.profiles where email = 'clt@a';
insert into public.project_team (project_id, user_id, project_role, employment_type)
select '00000000-0000-4000-8000-0000000000a1', id, 'engineering', 'pj' from public.profiles where email = 'pj@a';

insert into public.project_services (id, project_id, service_id, status)
select '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000a1', id, 'active'
from public.services where code = 'projeto_arquitetonico';
insert into public.project_schedule_tracks (id, project_id, project_service_id, status)
values ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000e1', 'in_progress');
insert into public.project_tasks (id, schedule_track_id, project_id, name, sequence, planned_duration_days, planned_start_date, planned_end_date, responsible_user_id, waiting_reason) values
  ('00000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', 'Planejamento', 1, 20, '2026-10-05', '2026-10-30',
   (select id from public.profiles where email = 'pj@a'), 'Justificativa interna'),
  ('00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', 'Briefing', 2, 7, '2026-11-02', '2026-11-10', null, null),
  ('00000000-0000-4000-8000-000000000073', '00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000a1', 'Estudo', 3, 20, '2026-11-11', '2026-12-08', null, null);
insert into public.task_dependencies (task_id, depends_on_task_id) values
  ('00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000071'),
  ('00000000-0000-4000-8000-000000000073', '00000000-0000-4000-8000-000000000072');

-- -----------------------------------------------------------------------------
-- ADM Global
-- -----------------------------------------------------------------------------
select tst.login('global@hq'); set role authenticated;
select tst.ok((select count(*) from public.tenants) = 3, 'ADM Global vê todas as unidades');
select tst.ok((select count(*) from public.projects) = 3, 'ADM Global vê todos os projetos');
select tst.ok((select count(*) from public.profiles) = 9, 'ADM Global vê todos os usuários');
select tst.ok(private.can_manage_templates(), 'ADM Global gerencia templates');
reset role;

-- -----------------------------------------------------------------------------
-- ADM Unidade A
-- -----------------------------------------------------------------------------
select tst.login('admin@a'); set role authenticated;
select tst.ok((select count(*) from public.tenants) = 1, 'ADM Unidade vê somente a própria unidade');
select tst.ok((select count(*) from public.projects) = 2, 'ADM Unidade A vê projetos executados/vendidos por A');
select tst.ok(not exists (select 1 from public.projects where id = '00000000-0000-4000-8000-0000000000b1'), 'ADM Unidade A não vê projeto da Franquia B');
select tst.ok(not exists (select 1 from public.profiles where tenant_id = '00000000-0000-4000-8000-00000000000b'), 'ADM Unidade A não vê usuários de B');
select tst.ok(not exists (select 1 from public.clients where tenant_id = '00000000-0000-4000-8000-00000000000b'), 'ADM Unidade A não vê clientes de B');
select tst.ok(not private.can_manage_templates(), 'ADM Unidade não altera templates globais');
select tst.throws($$insert into public.profiles (tenant_id, name, email, role) values ('00000000-0000-4000-8000-00000000000a', 'X Global', 'x@a', 'global_admin')$$,
  'ADM Unidade não cria ADM Global');
select tst.throws($$insert into public.profiles (tenant_id, name, email, role) values ('00000000-0000-4000-8000-000000000001', 'X Global', 'x@hq', 'global_admin')$$,
  'ADM Unidade não cria ADM Global nem na franqueadora');
select tst.throws($$insert into public.profiles (tenant_id, name, email, role, employment_type) values ('00000000-0000-4000-8000-00000000000b', 'Y', 'y@b', 'collaborator', 'pj')$$,
  'ADM Unidade não cria usuário em outra unidade');
insert into public.profiles (tenant_id, name, email, role, employment_type)
  values ('00000000-0000-4000-8000-00000000000a', 'Nova PJ', 'nova@a', 'collaborator', 'pj');
select tst.ok(exists (select 1 from public.profiles where email = 'nova@a'), 'ADM Unidade cria colaborador na própria unidade');
select tst.throws($$insert into public.profiles (tenant_id, name, email, role) values ('00000000-0000-4000-8000-00000000000a', 'Sem vínculo', 'semv@a', 'collaborator')$$,
  'Colaborador exige CLT/PJ');
select tst.throws($$update public.tenants set status = 'inativo' where id = '00000000-0000-4000-8000-00000000000a'$$,
  'ADM Unidade não altera status da própria unidade');
select tst.ok((select count(*) from public.tenants where id = '00000000-0000-4000-8000-00000000000b') = 0, 'ADM Unidade não enxerga a unidade B');
select tst.throws($$update public.profiles set role = 'leader' where email = 'admin@a'$$, 'Usuário não altera o próprio papel');
select tst.throws($$insert into public.audit_logs (action, entity_type) values ('fake', 'x')$$, 'Auditoria não aceita escrita direta');
select tst.ok(not exists (select 1 from public.audit_logs where tenant_id = '00000000-0000-4000-8000-00000000000b'), 'ADM Unidade A não vê auditoria de B');
reset role;

-- -----------------------------------------------------------------------------
-- Líderes
-- -----------------------------------------------------------------------------
select tst.login('lider@a'); set role authenticated;
select tst.ok(private.can_view_performance((select id from public.profiles where email = 'clt@a')), 'Líder analisa CLT');
select tst.ok(private.can_view_performance((select id from public.profiles where email = 'pj@a')), 'Líder mede a performance de PJ (o PJ não vê a própria)');
select tst.ok(private.can_edit_schedule('00000000-0000-4000-8000-0000000000a2'), 'Líder A edita cronograma de projeto executado por A');
update public.project_tasks set planned_end_date = '2026-11-03' where id = '00000000-0000-4000-8000-000000000071';
select tst.ok((select planned_end_date from public.project_tasks where id = '00000000-0000-4000-8000-000000000071') = '2026-11-03', 'Líder reprograma etapa');
reset role;

select tst.login('lider@b'); set role authenticated;
select tst.ok((select count(*) from public.projects) = 1, 'Líder B vê somente projetos de B');
select tst.ok((select count(*) from public.project_tasks) = 0, 'Líder B não vê etapas de A');
update public.project_tasks set name = 'invadido' where id = '00000000-0000-4000-8000-000000000071';
reset role;
select tst.ok((select name from public.project_tasks where id = '00000000-0000-4000-8000-000000000071') = 'Planejamento', 'Líder B não altera etapa de A');

-- -----------------------------------------------------------------------------
-- Colaboradores
-- -----------------------------------------------------------------------------
select tst.login('clt@a'); set role authenticated;
select tst.ok((select count(*) from public.projects) = 1, 'CLT vê apenas projetos em que está na equipe');
select tst.ok(private.can_view_performance((select id from public.profiles where email = 'clt@a')), 'CLT vê a própria performance');
select tst.ok(not exists (select 1 from public.profiles where role = 'client'), 'Colaborador não vê perfis de clientes');
select tst.ok(not exists (select 1 from public.audit_logs), 'Colaborador não vê auditoria');
reset role;

select tst.login('pj@a'); set role authenticated;
select tst.ok(not private.can_view_performance((select id from public.profiles where email = 'pj@a')), 'PJ não vê performance (nem a própria)');
update public.project_tasks set status = 'in_progress', actual_start_date = '2026-10-06' where id = '00000000-0000-4000-8000-000000000071';
select tst.ok((select status from public.project_tasks where id = '00000000-0000-4000-8000-000000000071') = 'in_progress', 'Responsável atualiza status da própria etapa');
select tst.throws($$update public.project_tasks set planned_end_date = '2027-01-01' where id = '00000000-0000-4000-8000-000000000071'$$,
  'Responsável não reprograma prazo previsto');
reset role;

select tst.login('nova@a'); set role authenticated;
select tst.ok((select count(*) from public.projects) = 0, 'Colaborador fora da equipe não vê projetos');
reset role;

-- -----------------------------------------------------------------------------
-- Cliente
-- -----------------------------------------------------------------------------
select tst.login('cliente@a'); set role authenticated;
select tst.ok((select count(*) from public.projects) = 1, 'Cliente vê somente o próprio projeto');
select tst.ok((select count(*) from public.clients) = 1, 'Cliente não vê outros clientes');
select tst.ok((select count(*) from public.project_tasks) = 0, 'Cliente não lê etapas internas diretamente (sem justificativas internas)');
select tst.ok((select count(*) from public.project_team) = 2, 'Cliente vê a equipe do próprio projeto');
select tst.ok((select count(*) from public.project_allocations) = 0, 'Cliente não vê dados de distribuição');
select tst.ok(not private.can_view_performance((select id from public.people where name = 'Davi CLT')), 'Cliente não vê performance');
select tst.ok((select count(*) from public.people) = 3, 'Cliente vê no diretório apenas a si e a equipe do projeto');
reset role;

-- -----------------------------------------------------------------------------
-- Usuário inativo
-- -----------------------------------------------------------------------------
select tst.login('inativo@a'); set role authenticated;
select tst.ok(private.current_profile_id() is null, 'Inativo não tem identidade ativa');
select tst.ok((select count(*) from public.tenants) = 0, 'Inativo não vê nenhum dado');
reset role;
select tst.ok(public.custom_access_token_hook(jsonb_build_object(
  'user_id', (select auth_user_id from public.profiles where email = 'inativo@a'), 'claims', '{}'::jsonb)) ? 'error',
  'Auth hook bloqueia token de usuário inativo');
select tst.ok(public.custom_access_token_hook(jsonb_build_object(
  'user_id', (select auth_user_id from public.profiles where email = 'clt@a'), 'claims', '{}'::jsonb)) -> 'claims' ->> 'app_role' = 'collaborator',
  'Auth hook emite claims para usuário ativo');
select tst.ok(public.custom_access_token_hook(jsonb_build_object('user_id', gen_random_uuid(), 'claims', '{}'::jsonb)) ? 'error',
  'Auth hook bloqueia usuário sem convite');

-- Unidade inativa derruba todos os seus usuários.
select tst.login('');
update public.tenants set status = 'inativo' where id = '00000000-0000-4000-8000-00000000000b';
select tst.login('admin@b'); set role authenticated;
select tst.ok(private.current_profile_id() is null, 'Usuários de unidade inativa perdem acesso');
reset role; select tst.login('');
update public.tenants set status = 'ativo' where id = '00000000-0000-4000-8000-00000000000b';

-- -----------------------------------------------------------------------------
-- Integridade
-- -----------------------------------------------------------------------------
select tst.login('');
select tst.throws($$insert into public.task_dependencies (task_id, depends_on_task_id) values ('00000000-0000-4000-8000-000000000071', '00000000-0000-4000-8000-000000000073')$$,
  'Dependência circular é rejeitada');
insert into public.project_intakes (source, external_id, raw_payload) values ('pipefy', 'card-123', '{"a":1}');
select tst.throws($$insert into public.project_intakes (source, external_id, raw_payload) values ('pipefy', 'card-123', '{"a":1}')$$,
  'Webhook duplicado não gera segunda entrada (idempotência)');
select tst.throws($$update public.project_intakes set raw_payload = '{}' where external_id = 'card-123'$$, 'Payload original é imutável');
select tst.throws($$update public.template_tasks set default_duration_days = 99 where code = 'planejamento'$$,
  'Template publicado é imutável (exige nova versão)');
select tst.throws($$insert into public.profiles (tenant_id, name, email, role) values ('00000000-0000-4000-8000-00000000000a', 'Global na franquia', 'g@a', 'global_admin')$$,
  'ADM Global só existe na franqueadora');
select tst.ok((select count(*) from public.audit_logs where entity_type = 'project_tasks' and action = 'rescheduled') >= 1,
  'Reprogramação gera auditoria "rescheduled"');
select tst.ok((select count(*) from public.audit_logs where entity_type = 'profiles' and action = 'created') >= 10,
  'Criação de usuários é auditada');

-- -----------------------------------------------------------------------------
-- Catálogo e calendário
-- -----------------------------------------------------------------------------
select tst.ok((select count(*) from public.services) = 26, 'Catálogo com 26 serviços (inclui 7 trâmites de aprovação)');
select tst.ok((select count(*) from public.services where has_schedule_template) = 20, '20 serviços com cronograma padrão (inclui 8 trâmites)');
select tst.ok(not (select available_for_b2c from public.services where code = 'spda'), 'SPDA indisponível para B2C');
select tst.ok((select count(*) from public.template_tasks tt join public.schedule_templates st on st.id = tt.template_id
               join public.services s on s.id = st.service_id where s.code = 'projeto_arquitetonico') = 5, 'Arquitetônico com 5 etapas');
select tst.ok((select count(*) from public.schedule_templates st join public.services s on s.id = st.service_id
               where s.code = 'design_interiores' and st.active) = 2, 'Interiores com 2 variantes por área');
select tst.ok((select count(*) from public.package_services ps join public.service_packages p on p.id = ps.package_id
               where p.code = 'projetos_complementares') = 2, 'Pacote Complementares expande para 2 serviços');
select tst.ok(public.add_business_days('2026-10-05', 5) = '2026-10-09', '5 dias úteis a partir de segunda terminam na sexta');
select tst.ok(public.add_business_days('2026-10-09', 2) = '2026-10-12', 'Fim de semana é ignorado');
select tst.ok(public.add_business_days('2026-10-10', 1) = '2026-10-12', 'Início no sábado começa na segunda');
insert into public.holidays (calendar_id, date, name, recurring) values ('00000000-0000-4000-8000-000000000101', '2026-10-12', 'Nossa Senhora Aparecida', true);
select tst.ok(public.add_business_days('2026-10-09', 2, '00000000-0000-4000-8000-000000000101') = '2026-10-13', 'Feriado é ignorado');
select tst.ok(public.business_days_between('2026-10-05', '2026-10-16', '00000000-0000-4000-8000-000000000101') = 9, 'Contagem de dias úteis com feriado');

drop schema tst cascade;
