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



-- Projeto A começa com o padrão vigente
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "8001", "cliente": {"nome": "Ana", "email": "ana8@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Projeto A", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
reset role;
create function tst.proj(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
create function tst.t(p_ext text, p_code text) returns public.project_tasks language sql as $$
  select t.* from public.project_tasks t where t.project_id = tst.proj(p_ext) and t.code = p_code $$;
create function tst.arq_active() returns uuid language sql as $$
  select t.id from public.schedule_templates t join public.services s on s.id = t.service_id where s.code = 'projeto_arquitetonico' and t.active $$;
grant execute on all functions in schema tst to authenticated;

select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.proj('8001'), jsonb_build_array(jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq'))));
reset role; select tst.login('');
create temp table before_a as select id, code, planned_duration_days, planned_start_date, planned_end_date, template_task_id from public.project_tasks where project_id = tst.proj('8001');
create temp table v_old as select tst.arq_active() as id;

-- ADM Global altera o padrão: nova versão com Planejamento em 35 d.u. e uma etapa extra
select tst.login('ga@hq'); set role authenticated;
select public.create_template_draft(null, tst.arq_active());
reset role; select tst.login('');
update public.template_tasks tt set default_duration_days = 35
  from public.schedule_templates st, public.services s
 where st.id = tt.template_id and s.id = st.service_id and s.code = 'projeto_arquitetonico' and st.status = 'draft' and tt.code = 'planejamento';
select tst.login('ga@hq'); set role authenticated;
select public.publish_template((select st.id from public.schedule_templates st join public.services s on s.id = st.service_id
  where s.code = 'projeto_arquitetonico' and st.status = 'draft'), 'Planejamento maior');
reset role; select tst.login('');
select tst.ok(tst.arq_active() <> (select id from v_old), 'Publicar cria uma nova versão vigente (a anterior é arquivada)');

-- Projeto A (em andamento) não muda
select tst.ok(not exists (select 1 from public.project_tasks t join before_a b on b.id = t.id
  where t.planned_duration_days is distinct from b.planned_duration_days or t.planned_start_date is distinct from b.planned_start_date
     or t.planned_end_date is distinct from b.planned_end_date or t.template_task_id is distinct from b.template_task_id),
  'Projeto em andamento mantém prazos e etapas da versão com que começou');
select tst.ok((select count(*) from public.project_tasks where project_id = tst.proj('8001')) = (select count(*) from before_a), 'Nenhuma etapa entra ou sai do projeto em andamento');
select tst.ok((select template_id from public.project_schedule_tracks where project_id = tst.proj('8001')) = (select id from v_old), 'Trilha do projeto continua ligada à versão antiga');

-- Recalcular o cronograma do projeto A também não puxa o padrão novo
select tst.login('lid@hq'); set role authenticated;
select public.reschedule_task((tst.t('8001', 'envio_briefing')).id, null, 9, 'Teste de recálculo');
reset role; select tst.login('');
select tst.ok((tst.t('8001', 'planejamento')).planned_duration_days = (select planned_duration_days from before_a where code = 'planejamento'),
  'Recalcular não traz a duração do padrão novo');

-- Projeto B (novo) usa a versão nova
set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "8002", "cliente": {"nome": "Bia", "email": "bia8@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Projeto B", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "06/10/2026"}'::jsonb);
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team(tst.proj('8002'), jsonb_build_array(jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq'))));
reset role; select tst.login('');
select tst.ok((tst.t('8002', 'planejamento')).planned_duration_days = 35, 'Projeto novo recebe o padrão alterado');
select tst.ok((select template_id from public.project_schedule_tracks where project_id = tst.proj('8002')) = tst.arq_active(), 'Projeto novo ligado à versão vigente');

-- Versão publicada não pode ser editada (só por nova versão)
select tst.throws($$update public.template_tasks set default_duration_days = 1 where template_id = (select id from v_old)$$,
  'Versão publicada é imutável');
