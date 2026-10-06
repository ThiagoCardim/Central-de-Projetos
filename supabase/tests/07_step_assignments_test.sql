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


-- Projeto que ainda não começou: duas trilhas, uma aguardará área (Interiores sem área)
set role service_role;
select public.ingest_crm_webhook('pipefy', '{
  "card_id": "4001", "cliente": {"nome": "Bia Reis", "email": "bia@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Reis"},
  "servicos": "Projeto Arquitetônico, Design de Interiores",
  "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.pid() returns uuid language sql as $$ select id from public.projects where external_id = '4001' $$;
grant execute on function tst.pid() to authenticated;

-- Opções de sub-etapas antes do início: vêm do padrão
select tst.login('lid@hq'); set role authenticated;
select tst.ok((select count(*) from public.project_step_options(tst.pid()) where project_service_id = tst.ps('projeto_arquitetonico')) >= 5,
  'Sub-etapas do Arquitetônico disponíveis antes do início (do padrão)');
select tst.ok((select count(*) from public.project_step_options(tst.pid()) where project_service_id = tst.ps('design_interiores')) >= 3,
  'Interiores sem área: mostra o padrão vigente do serviço');
select tst.ok(not (select bool_or(from_schedule) from public.project_step_options(tst.pid())), 'Ainda não há cronograma gerado');
reset role; select tst.login('');

select tst.login('r3d@hq'); set role authenticated;
select tst.throws(format($$select public.set_step_assignments(%L, '[]'::jsonb)$$, tst.pid()), 'Colaborador não define equipe');
reset role; select tst.login('');

-- Início: líder + diretos, depois as sub-etapas do indireto
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('arq@hq')),
  jsonb_build_object('project_service_id', tst.ps('design_interiores'), 'user_id', tst.uid('arq@hq')),
  jsonb_build_object('project_role', 'support', 'user_id', tst.uid('r3d@hq'))));
select tst.throws(format($$select public.set_step_assignments(%L, %L::jsonb)$$, tst.pid(), jsonb_build_array(
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'task_code', 'imagens_3d_video', 'user_id', tst.uid('r3d@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'task_code', 'imagens_3d_video', 'user_id', tst.uid('out@hq')))),
  'Uma etapa não pode ter dois colaboradores indiretos');
select public.set_step_assignments(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'task_code', 'imagens_3d_video', 'user_id', tst.uid('r3d@hq')),
  jsonb_build_object('project_service_id', tst.ps('design_interiores'), 'task_code', 'renderizacao', 'user_id', tst.uid('r3d@hq'))));
reset role; select tst.login('');

select tst.ok((tst.task('projeto_arquitetonico', 'imagens_3d_video')).responsible_user_id = tst.uid('r3d@hq'),
  'Etapa já gerada passa para o colaborador indireto');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).responsible_user_id = tst.uid('arq@hq'),
  'Demais etapas continuam com o responsável direto');
select tst.ok((tst.task('design_interiores', 'renderizacao')).id is null, 'Interiores ainda sem etapas (aguardando área)');
select tst.ok(exists (select 1 from public.notifications where kind = 'task_assigned' and recipient_profile_id = tst.uid('r3d@hq')),
  'Colaborador indireto é avisado');

-- Área informada: etapas nascem já com o indireto na sub-etapa escolhida
select tst.login('lid@hq'); set role authenticated;
select public.set_project_area(tst.pid(), 200);
reset role; select tst.login('');
select tst.ok((tst.task('design_interiores', 'renderizacao')).responsible_user_id = tst.uid('r3d@hq'),
  'Etapa gerada depois já nasce com o colaborador indireto');
select tst.ok((tst.task('design_interiores', 'planejamento')).responsible_user_id = tst.uid('arq@hq'),
  'Outras etapas de Interiores nascem com o responsável direto');

select tst.login('lid@hq'); set role authenticated;
select tst.ok((select user_id from public.project_step_options(tst.pid()) where task_code = 'imagens_3d_video') = tst.uid('r3d@hq'),
  'Opções mostram quem responde por cada sub-etapa');
-- Remove uma sub-etapa: volta para o responsável direto
select public.set_step_assignments(tst.pid(), jsonb_build_array(
  jsonb_build_object('project_service_id', tst.ps('design_interiores'), 'task_code', 'renderizacao', 'user_id', tst.uid('r3d@hq'))));
reset role; select tst.login('');
select tst.ok((tst.task('projeto_arquitetonico', 'imagens_3d_video')).responsible_user_id = tst.uid('arq@hq'),
  'Sub-etapa removida volta para o responsável direto');
select tst.ok((select count(*) from public.project_step_assignments where project_id = tst.pid() and not active) = 1,
  'Vínculo removido fica no histórico (inativo)');

-- Outra pessoa de fora não vê os vínculos
select tst.login('out@hq'); set role authenticated;
select tst.ok(not exists (select 1 from public.project_step_assignments), 'Quem não está no projeto não vê os vínculos');
reset role; select tst.login('');
