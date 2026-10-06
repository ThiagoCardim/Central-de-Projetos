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
  join public.projects p on p.id = ps.project_id where p.external_id = '3001' and s.code = p_service $$;
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

select tst.ok((select count(*) from public.task_library) >= 20, 'Biblioteca de etapas já vem com as etapas dos padrões YouCon');
select tst.ok(exists (select 1 from public.task_library where name = 'Vídeo 3D'), 'Biblioteca inclui sub-etapas da operação');

set role service_role;
select public.ingest_crm_webhook('pipefy', '{
  "card_id": "3001", "cliente": {"nome": "Carla Dias", "email": "carla@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Dias", "area_m2": "220"},
  "servicos": "Projeto Arquitetônico, Projeto Estrutural, Projetos Complementares",
  "data_fechamento": "01/10/2026"}'::jsonb);
reset role;

-- Equipe: Líder + responsável direto por serviço (dois engenheiros diferentes)
select tst.login('lid@hq'); set role authenticated;
select tst.throws(format($$select public.assign_project_team(%L, %L::jsonb)$$, (select id from public.projects where external_id = '3001'),
  jsonb_build_array(jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq')),
                    jsonb_build_object('project_service_id', gen_random_uuid(), 'user_id', tst.uid('arq@hq')))),
  'Serviço de outro projeto é recusado');
select public.assign_project_team((select id from public.projects where external_id = '3001'), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('arq@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_estrutural'), 'user_id', tst.uid('est@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_eletrico'), 'user_id', tst.uid('comp@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_hidrossanitario'), 'user_id', tst.uid('comp@hq'))));
reset role; select tst.login('');

select tst.ok((select responsible_user_id from public.project_services where id = tst.ps('projeto_estrutural')) = tst.uid('est@hq'), 'Responsável direto do Estrutural');
select tst.ok((select responsible_user_id from public.project_services where id = tst.ps('projeto_eletrico')) = tst.uid('comp@hq'), 'Responsável direto dos Complementares');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).responsible_user_id = tst.uid('arq@hq'), 'Etapas da Arquitetura nascem com a arquiteta');
select tst.ok((tst.task('projeto_estrutural', 'planejamento')).responsible_user_id = tst.uid('est@hq'), 'Etapas do Estrutural nascem com o engenheiro do estrutural');
select tst.ok((tst.task('projeto_eletrico', 'planejamento')).responsible_user_id = tst.uid('comp@hq'), 'Etapas dos Complementares nascem com o outro engenheiro');
select tst.ok((select count(*) from public.project_team where project_id = (select id from public.projects where external_id = '3001') and active) = 4,
  'Equipe: líder + 3 pessoas (um vínculo por pessoa e função)');

-- Colaborador indireto numa etapa específica
select tst.login('r3d@hq'); set role authenticated;
select tst.ok(not exists (select 1 from public.projects where external_id = '3001'), 'Renderista ainda não vê o projeto');
reset role; select tst.login('');
select tst.login('lid@hq'); set role authenticated;
select public.set_task_responsible((tst.task('projeto_arquitetonico', 'imagens_3d_video')).id, tst.uid('r3d@hq'));
reset role; select tst.login('');
select tst.ok(exists (select 1 from public.project_team where user_id = tst.uid('r3d@hq') and project_role = 'support' and active),
  'Responsável de etapa fora da equipe entra como colaborador indireto');
select tst.login('r3d@hq'); set role authenticated;
select tst.ok(exists (select 1 from public.projects where external_id = '3001'), 'Colaborador indireto passa a ver o projeto');
select tst.ok(public.set_task_status((tst.task('projeto_arquitetonico', 'imagens_3d_video')).id, 'in_progress') ->> 'status' = 'in_progress',
  'Colaborador indireto atualiza a própria etapa');
reset role; select tst.login('');

-- Trocar responsável direto: etapas abertas acompanham; etapa de outra pessoa fica
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team((select id from public.projects where external_id = '3001'), jsonb_build_array(
  jsonb_build_object('project_role', 'project_lead', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_arquitetonico'), 'user_id', tst.uid('out@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_estrutural'), 'user_id', tst.uid('est@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_eletrico'), 'user_id', tst.uid('comp@hq')),
  jsonb_build_object('project_service_id', tst.ps('projeto_hidrossanitario'), 'user_id', tst.uid('comp@hq')),
  jsonb_build_object('project_role', 'support', 'user_id', tst.uid('r3d@hq'))));
reset role; select tst.login('');
select tst.ok((tst.task('projeto_arquitetonico', 'estudo_preliminar')).responsible_user_id = tst.uid('out@hq'), 'Troca do responsável direto passa às etapas abertas');
select tst.ok((tst.task('projeto_arquitetonico', 'imagens_3d_video')).responsible_user_id = tst.uid('r3d@hq'), 'Etapa com responsável próprio é preservada');
select tst.ok(not exists (select 1 from public.project_team where user_id = tst.uid('arq@hq') and active), 'Quem saiu da equipe perde o vínculo');

-- Etapa extra no projeto, da biblioteca, com responsável próprio
select tst.login('arq@hq'); set role authenticated;
select tst.throws(format($$select public.add_project_task(%L, null, 'X', null, 3, 'fixed', null, true, 'teste')$$,
  (select id from public.project_schedule_tracks where project_service_id = tst.ps('projeto_arquitetonico'))), 'Colaborador não inclui etapas');
reset role; select tst.login('');

select (tst.task('projeto_arquitetonico', 'alteracoes')).planned_end_date as alt_end,
       (tst.task('projeto_arquitetonico', 'imagens_3d_video')).planned_start_date as img_start \gset
select tst.login('lid@hq'); set role authenticated;
select public.add_project_task(
  (select id from public.project_schedule_tracks where project_service_id = tst.ps('projeto_arquitetonico')),
  (tst.task('projeto_arquitetonico', 'alteracoes')).id, 'Projeto Executivo', null, 10, 'fixed', tst.uid('comp@hq'), true,
  'Cliente contratou executivo') as added \gset
select tst.throws(format($$select public.add_project_task(%L, null, 'Etapa', null, 3, 'dependent', null, true, 'teste')$$,
  (select id from public.project_schedule_tracks where project_service_id = tst.ps('projeto_arquitetonico'))), 'Etapa extra não pode ser dependente');
select public.add_project_task(
  (select id from public.project_schedule_tracks where project_service_id = tst.ps('projeto_estrutural')),
  null, 'Visita técnica ao terreno', 'Levantamento antes do briefing', 2, 'fixed', null, false, 'Terreno com desnível', true);
reset role; select tst.login('');

select tst.ok((select name from public.project_tasks where id = (:'added'::jsonb ->> 'task_id')::uuid) = 'Projeto Executivo', 'Etapa extra criada');
select tst.ok((select planned_start_date from public.project_tasks where id = (:'added'::jsonb ->> 'task_id')::uuid) =
              public.next_business_day(:'alt_end'::date + 1), 'Etapa extra começa depois da etapa de referência');
select tst.ok((tst.task('projeto_arquitetonico', 'imagens_3d_video')).planned_start_date = :'img_start'::date,
  'Etapa já iniciada não muda de data');
select tst.ok(exists (select 1 from public.task_dependencies where task_id = (tst.task('projeto_arquitetonico', 'imagens_3d_video')).id
               and depends_on_task_id = (:'added'::jsonb ->> 'task_id')::uuid), 'Em sequência: a etapa seguinte passa a esperar a nova');
select tst.ok((select sequence from public.project_tasks where id = (:'added'::jsonb ->> 'task_id')::uuid)
              < (tst.task('projeto_arquitetonico', 'imagens_3d_video')).sequence, 'Ordem visual mantida');
select tst.ok(exists (select 1 from public.project_team where user_id = tst.uid('comp@hq') and project_role = 'support' and active)
              or exists (select 1 from public.project_team where user_id = tst.uid('comp@hq') and active), 'Responsável da etapa extra tem acesso');
select tst.ok(exists (select 1 from public.task_library where name = 'Visita técnica ao terreno'), 'Nova etapa salva na biblioteca');
select tst.ok((select reason from public.task_changes where task_id = (:'added'::jsonb ->> 'task_id')::uuid) = 'Cliente contratou executivo', 'Histórico com motivo');

-- Biblioteca: equipe lê, gestores registram, colaborador não
select tst.login('arq@hq'); set role authenticated;
select tst.ok((select count(*) from public.task_library) > 0, 'Colaborador vê a biblioteca');
select tst.throws($$insert into public.task_library (name) values ('Etapa qualquer')$$, 'Colaborador não registra etapa na biblioteca');
reset role; select tst.login('');
select tst.login('lid@hq'); set role authenticated;
insert into public.task_library (name, default_duration_days, created_by) values ('Revisão final com cliente', 3, tst.uid('lid@hq'));
select tst.throws($$insert into public.task_library (name) values ('revisão final com cliente ')$$, 'Nome repetido na biblioteca é recusado');
reset role; select tst.login('');

-- Foto de perfil
select tst.login('arq@hq'); set role authenticated;
select public.set_profile_avatar(tst.uid('arq@hq'), 'https://x.supabase.co/storage/v1/object/public/avatars/' || tst.uid('arq@hq') || '/foto.jpg?v=1');
select tst.throws(format('select public.set_profile_avatar(%L, %L)', tst.uid('est@hq'),
  'https://x.supabase.co/storage/v1/object/public/avatars/' || tst.uid('est@hq') || '/foto.jpg'), 'Colaborador não troca a foto de outra pessoa');
select tst.throws(format('select public.set_profile_avatar(%L, %L)', tst.uid('arq@hq'), 'https://site-qualquer.com/foto.jpg'), 'Foto precisa vir do armazenamento da plataforma');
reset role; select tst.login('');
select tst.ok((select avatar_url from public.profiles where email = 'arq@hq') like '%/avatars/%', 'Pessoa troca a própria foto');
select tst.login('ga@hq'); set role authenticated;
select public.set_profile_avatar(tst.uid('est@hq'), 'https://x.supabase.co/storage/v1/object/public/avatars/' || tst.uid('est@hq') || '/a.png');
select public.set_profile_avatar(tst.uid('est@hq'), null);
reset role; select tst.login('');
select tst.ok((select avatar_url from public.profiles where email = 'est@hq') is null, 'Administrador troca e remove a foto de colaboradores');

\echo '✔ Equipe por serviço, biblioteca e foto'
