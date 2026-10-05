-- Testes das RPCs de usuários/unidades e do payload da Home por perfil.
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
  begin execute stmt; exception when others then raise notice 'ok - % (bloqueado: %)', msg, sqlerrm; return; end;
  raise exception 'FALHOU (deveria bloquear): %', msg;
end $$;
create function tst.login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',
    coalesce((select auth_user_id::text from public.profiles where email = p_email), ''), false);
end $$;
grant execute on all functions in schema tst to authenticated;

-- Cenário reaproveitado do teste 01 (o banco é recriado do zero a cada execução)
insert into public.tenants (id, name, type, parent_tenant_id, slug) values
  ('00000000-0000-4000-8000-00000000000a', 'Franquia A', 'franquia', '00000000-0000-4000-8000-000000000001', 'franquia-a')
on conflict (id) do nothing;
insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['g2@hq','adm2@a','lid2@a','col2@a','cli2@a']) e;
insert into public.profiles (auth_user_id, tenant_id, name, email, role, employment_type, client_type)
select u.id, t.tid, t.name, t.email, t.role::public.user_role, t.emp::public.employment_type, t.ct::public.client_type
from (values
  ('g2@hq',  '00000000-0000-4000-8000-000000000001'::uuid, 'Global Dois', 'global_admin', null, null),
  ('adm2@a', '00000000-0000-4000-8000-00000000000a'::uuid, 'Adm Dois',    'unit_admin',  null, null),
  ('lid2@a', '00000000-0000-4000-8000-00000000000a'::uuid, 'Líder Dois',  'leader',      'clt', null),
  ('col2@a', '00000000-0000-4000-8000-00000000000a'::uuid, 'Col Dois',    'collaborator','clt', null)
) t(email, tid, name, role, emp, ct)
join auth.users u on u.email = t.email;
insert into public.clients (id, tenant_id, name, client_type)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-00000000000a', 'Cliente Dois', 'b2c');
insert into public.projects (id, client_id, name, client_type, commercial_tenant_id, delivery_tenant_id, status, city, contracted_at) values
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d1', 'Residência Dois', 'b2c',
   '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'in_progress', 'Poços de Caldas', '2026-09-01'),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-0000000000d1', 'Ampliação Dois', 'b2c',
   '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 'awaiting_team_assignment', 'Poços de Caldas', '2026-10-01');
insert into public.project_services (id, project_id, service_id, status)
select '00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-0000000000d2', id, 'active' from public.services where code = 'projeto_arquitetonico';
insert into public.project_services (project_id, service_id, status)
select '00000000-0000-4000-8000-0000000000d3', id, 'pending_review' from public.services where code = 'design_interiores';
insert into public.project_schedule_tracks (id, project_id, project_service_id, status, planned_end_date)
values ('00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d4', 'in_progress', current_date + 60);
insert into public.project_tasks (schedule_track_id, project_id, name, sequence, planned_start_date, planned_end_date, status, responsible_user_id, waiting_reason)
select '00000000-0000-4000-8000-0000000000d5', '00000000-0000-4000-8000-0000000000d2', x.name, x.seq, x.s, x.e, x.st::public.task_status,
       (select id from public.profiles where email = 'col2@a'), x.why
from (values
  ('Planejamento',      1, current_date - 30, current_date - 4, 'completed',      null),
  ('Envio do Briefing', 2, current_date - 3,  current_date - 1, 'waiting_client', 'Cliente não enviou medidas'),
  ('Estudo Preliminar', 3, current_date,      current_date + 20, 'not_started',   null)
) x(name, seq, s, e, st, why);
insert into public.project_team (project_id, user_id, project_role)
select '00000000-0000-4000-8000-0000000000d2', id, 'architecture' from public.profiles where email = 'col2@a';

-- -----------------------------------------------------------------------------
-- Convite de usuários
-- -----------------------------------------------------------------------------
select tst.login('adm2@a'); set role authenticated;
select tst.ok(public.admin_prepare_user('00000000-0000-4000-8000-00000000000a', 'Cli Dois', 'CLI2@a', 'client',
              null, 'b2c', '00000000-0000-4000-8000-0000000000d1') is not null, 'ADM Unidade convida cliente vinculado ao cliente');
select tst.ok((select email::text from public.profiles where name = 'Cli Dois') = 'cli2@a', 'E-mail normalizado em minúsculas');
select tst.throws($$select public.admin_prepare_user('00000000-0000-4000-8000-00000000000a', 'Dup', 'cli2@a', 'collaborator', 'pj')$$, 'E-mail duplicado é rejeitado');
select tst.throws($$select public.admin_prepare_user('00000000-0000-4000-8000-00000000000a', 'Sem cliente', 'sc@a', 'client', null, 'b2c')$$, 'Usuário cliente exige cliente vinculado');
select tst.throws($$select public.admin_prepare_user('00000000-0000-4000-8000-000000000001', 'Intruso', 'int@hq', 'collaborator', 'clt')$$, 'ADM Unidade não convida na franqueadora');
select tst.ok((public.my_permissions() ->> 'can_manage_users')::boolean, 'my_permissions: ADM Unidade gerencia usuários');
select tst.ok(not (public.my_permissions() ->> 'can_manage_templates')::boolean, 'my_permissions: ADM Unidade não gerencia templates');
select public.admin_set_user_status((select id from public.profiles where email = 'col2@a'), 'inativo');
select tst.ok((select status from public.profiles where email = 'col2@a') = 'inativo', 'ADM Unidade desativa colaborador');
select public.admin_set_user_status((select id from public.profiles where email = 'col2@a'), 'ativo');
select tst.ok((select count(*) from public.audit_logs where action in ('deactivated','reactivated')) >= 2, 'Desativação/reativação auditadas');
select tst.throws($$select public.admin_create_tenant('Franquia Pirata', 'pirata')$$, 'ADM Unidade não cria unidades');
reset role; select tst.login('');

-- Link do auth só por service_role
select tst.login('adm2@a'); set role authenticated;
select tst.throws($$select public.admin_link_auth_user((select id from public.profiles where email = 'cli2@a'), gen_random_uuid())$$, 'App não vincula auth_user_id');
reset role; select tst.login('');
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000e9', 'cli2@a');
set role service_role;
select public.admin_link_auth_user((select id from public.profiles where email = 'cli2@a'), '00000000-0000-4000-8000-0000000000e9');
reset role;
select tst.ok((select auth_user_id from public.profiles where email = 'cli2@a') = '00000000-0000-4000-8000-0000000000e9', 'service_role vincula convite aceito');

-- -----------------------------------------------------------------------------
-- Home por perfil
-- -----------------------------------------------------------------------------
select tst.login('col2@a'); set role authenticated;
select tst.ok((public.get_home_dashboard() -> 'my_work' -> 'counts' ->> 'waiting_client')::int = 1, 'Colaborador: 1 etapa aguardando cliente');
select tst.ok((public.get_home_dashboard() -> 'my_work' -> 'counts' ->> 'overdue')::int = 1, 'Colaborador: 1 etapa atrasada');
select tst.ok(jsonb_array_length(public.get_home_dashboard() -> 'my_work' -> 'projects') = 1, 'Colaborador: 1 projeto na equipe');
select tst.ok(not (public.get_home_dashboard() ? 'operations'), 'Colaborador não recebe bloco de gestão');
select tst.ok(not (public.get_home_dashboard() ? 'admin'), 'Colaborador não recebe bloco administrativo');
reset role;

select tst.login('lid2@a'); set role authenticated;
select tst.ok(jsonb_array_length(public.get_home_dashboard() -> 'operations' -> 'awaiting_team') = 1, 'Líder: card "Novo projeto aguardando equipe"');
select tst.ok((public.get_home_dashboard() -> 'operations' -> 'awaiting_team' -> 0 -> 'services' ->> 0) = 'Design de Interiores', 'Card mostra serviços contratados');
select tst.ok((public.get_home_dashboard() -> 'operations' -> 'counts' ->> 'projects_at_risk')::int = 1, 'Líder: 1 projeto em risco');
select tst.ok((public.get_home_dashboard() -> 'operations' -> 'counts' ->> 'services_pending_review')::int = 1, 'Líder: novo serviço aguardando revisão');
select tst.ok(not (public.get_home_dashboard() ? 'admin'), 'Líder não recebe bloco administrativo');
reset role;

select tst.login('g2@hq'); set role authenticated;
select tst.ok(jsonb_array_length(public.get_home_dashboard() -> 'admin' -> 'tenants') >= 2, 'ADM Global: visão consolidada por unidade');
select tst.ok((public.get_home_dashboard() -> 'admin' -> 'users' ->> 'clt')::int >= 1, 'ADM Global: contagem CLT/PJ');
reset role;

select tst.login('cli2@a'); set role authenticated;
select tst.ok(public.get_home_dashboard() ? 'client' and not (public.get_home_dashboard() ? 'my_work'), 'Cliente recebe apenas a visão simplificada');
select tst.ok(jsonb_array_length(public.get_home_dashboard() -> 'client' -> 'projects') = 2, 'Cliente vê seus 2 projetos');
select tst.ok(position('Cliente não enviou medidas' in public.get_home_dashboard()::text) = 0, 'Justificativa interna nunca chega ao cliente');
select tst.ok(position('responsible' in public.get_home_dashboard()::text) = 0, 'Cliente não recebe dados internos de responsáveis');
select tst.ok((select (p -> 'services' -> 0 -> 'current_step' ->> 'name') from jsonb_array_elements(public.client_projects_overview()) p
               where p ->> 'name' = 'Residência Dois') = 'Envio do Briefing', 'Cliente vê a etapa atual');
select tst.ok((select (p ->> 'progress')::int from jsonb_array_elements(public.client_projects_overview()) p
               where p ->> 'name' = 'Residência Dois') = 33, 'Cliente vê o progresso (33%)');
reset role;

drop schema tst cascade;
