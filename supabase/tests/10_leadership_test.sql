-- Equipe por serviço, colaborador indireto, biblioteca de etapas, etapa extra e foto.
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
create function tst.ps(p_service text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
  join public.projects p on p.id = ps.project_id where p.external_id = '4001' and s.code = p_service $$;
create function tst.task(p_service text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  where tr.project_service_id = tst.ps(p_service) and t.code = p_code $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','lid@hq','arq@hq','est@hq','comp@hq','r3d@hq','out@hq']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', null),
       ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Arquiteta', 'arq@hq', 'collaborator', 'clt'),
       ('00000000-0000-4000-8000-000000000001', 'Eng. Estrutural', 'est@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Eng. Complementares', 'comp@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Renderista', 'r3d@hq', 'collaborator', 'pj'),
       ('00000000-0000-4000-8000-000000000001', 'Outra pessoa', 'out@hq', 'collaborator', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;



set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "7001", "cliente": {"nome": "Eva", "email": "eva@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Eva", "area_m2": "180"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '7001' $$;
create or replace function tst.ps(p_service text) returns uuid language sql as $$
  select ps.id from public.project_services ps join public.services s on s.id = ps.service_id
  join public.projects p on p.id = ps.project_id where p.external_id = '7001' and s.code = p_service $$;
grant execute on all functions in schema tst to authenticated;

select tst.ok((select leadership_area from public.services where code = 'projeto_estrutural') = 'engineering', 'Estrutural pertence à liderança de Engenharia');
select tst.ok((select leadership_area from public.services where code = 'aprovacao_projeto_legal') = 'approval', 'Aprovação pertence à liderança de Aprovação');

select tst.login('lid@hq'); set role authenticated;
select tst.throws(format($$select public.assign_project_team(%L, %L::jsonb)$$, tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('est@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('arq@hq')))),
  'Os 3 líderes são obrigatórios');
-- Só Arquitetônico contratado, mas os 3 líderes já ficam definidos
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('est@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('arq@hq'))));
reset role; select tst.login('');
select tst.ok((select count(*) from public.project_team where project_id = tst.pid() and active and project_role like 'lead%') = 3, '3 líderes definidos desde o início');
select tst.ok(private.project_leaders(tst.pid(), tst.ps('projeto_arquitetonico')) = array[tst.uid('lid@hq')], 'Líder do serviço de Arquitetura');

-- Engenharia contratada depois: o líder já está lá
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "7001-b", "tipo": "servico_adicional", "projeto_referencia": "7001",
  "servicos": "Projeto Estrutural", "data_fechamento": "05/10/2026"}'::jsonb);
reset role;
select tst.ok(private.project_leaders(tst.pid(), tst.ps('projeto_estrutural')) = array[tst.uid('est@hq')], 'Serviço de Engenharia contratado depois já tem líder');
select tst.ok(array_length(private.project_leaders(tst.pid()), 1) = 2, 'Sem serviço: líderes das 3 áreas (pessoas distintas)');
