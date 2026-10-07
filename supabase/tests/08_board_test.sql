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



-- Uma franquia com líder próprio (isolamento entre quadros)
insert into public.tenants (id, name, type, slug, parent_tenant_id) values ('00000000-0000-4000-8000-0000000000f1', 'Franquia Teste', 'franquia', 'franquia-teste', '00000000-0000-4000-8000-000000000001');
insert into auth.users (id, email) values (gen_random_uuid(), 'lidf@fr');
insert into public.profiles (tenant_id, name, email, role, employment_type)
values ('00000000-0000-4000-8000-0000000000f1', 'Líder Franquia', 'lidf@fr', 'leader', 'clt');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "5001", "cliente": {"nome": "Ana", "email": "ana@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Ana", "area_m2": "120"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/10/2026"}'::jsonb);
select public.ingest_crm_webhook('pipefy', '{"card_id": "5002", "cliente": {"nome": "Beto", "email": "beto@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Beto", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "02/10/2026"}'::jsonb);
reset role;
create function tst.col(p_name text) returns uuid language sql as $$
  select id from public.project_board_columns where name = p_name and active and tenant_id = '00000000-0000-4000-8000-000000000001' $$;
create function tst.proj(p_ext text) returns uuid language sql as $$ select id from public.projects where external_id = p_ext $$;
grant execute on all functions in schema tst to authenticated;

-- Colaborador não edita; líder abre o quadro (colunas iniciais + cards)
select tst.login('arq@hq'); set role authenticated;
select public.board_ensure();
select tst.throws($$select public.board_add_column('Revisão')$$, 'Colaborador não cria colunas');
reset role; select tst.login('');

select tst.ok((select count(*) from public.project_board_columns where tenant_id = '00000000-0000-4000-8000-000000000001' and active) = 3,
  'Quadro nasce com 3 colunas');
select tst.ok((select column_id from public.project_board_cards where project_id = tst.proj('5001')) = tst.col('A iniciar'),
  'Projeto aguardando ação começa em "A iniciar"');

select tst.login('lid@hq'); set role authenticated;
select public.board_ensure(); -- idempotente
select tst.ok((select count(*) from public.project_board_columns) = 3, 'Abrir de novo não duplica colunas');
select public.board_add_column('Revisão com cliente');
select tst.throws($$select public.board_add_column('revisão com cliente ')$$, 'Nome de coluna repetido é recusado');
select public.board_rename_column(tst.col('Revisão com cliente'), 'Aprovação do cliente');
select public.board_move_card(tst.proj('5001'), tst.col('Aprovação do cliente'));
select public.board_move_card(tst.proj('5002'), tst.col('Aprovação do cliente'), tst.proj('5001'));
select tst.ok((select array_agg(project_id order by sort_order) from public.project_board_cards where column_id = tst.col('Aprovação do cliente'))
  = array[tst.proj('5002'), tst.proj('5001')], 'Card entra antes do card indicado');
select public.board_reorder_columns(array[tst.col('Aprovação do cliente'), tst.col('A iniciar'), tst.col('Em andamento'), tst.col('Encerrados')]);
select tst.ok((select name from public.project_board_columns where active order by sort_order limit 1) = 'Aprovação do cliente', 'Colunas reordenadas');

-- Exclusão segura
select tst.throws(format($$select public.board_delete_column(%L, %L, 'errado')$$, tst.col('Aprovação do cliente'), tst.col('A iniciar')),
  'Excluir exige digitar o nome da coluna');
select tst.throws(format($$select public.board_delete_column(%L, null, 'Aprovação do cliente')$$, tst.col('Aprovação do cliente')),
  'Excluir exige escolher o destino dos projetos');
select tst.ok((public.board_delete_column(tst.col('Aprovação do cliente'), tst.col('Em andamento'), 'aprovação do cliente') ->> 'moved')::int = 2,
  'Coluna excluída move os 2 projetos');
reset role; select tst.login('');
select tst.ok((select count(*) from public.project_board_cards where column_id = tst.col('Em andamento')) = 2, 'Projetos foram para "Em andamento"');
select tst.ok(exists (select 1 from public.project_board_columns where name = 'Aprovação do cliente' and not active), 'Coluna excluída fica no histórico (inativa)');

select tst.login('lid@hq'); set role authenticated;
select public.board_delete_column(tst.col('A iniciar'), tst.col('Em andamento'), 'A iniciar');
select public.board_delete_column(tst.col('Encerrados'), tst.col('Em andamento'), 'Encerrados');
select tst.throws(format($$select public.board_delete_column(%L, %L, 'Em andamento')$$, tst.col('Em andamento'), tst.col('Em andamento')),
  'Não exclui a última coluna');
reset role; select tst.login('');

-- Isolamento: a franquia tem o próprio quadro e não vê o da Franqueadora
select tst.login('lidf@fr'); set role authenticated;
select public.board_ensure();
select tst.ok((select count(*) from public.project_board_columns) = 3, 'Franquia vê só as próprias colunas');
select tst.ok(not exists (select 1 from public.project_board_columns where tenant_id = '00000000-0000-4000-8000-000000000001'), 'Franquia não vê colunas da Franqueadora');
select tst.throws(format($$select public.board_rename_column(%L, 'x')$$, tst.col('Em andamento')), 'Franquia não altera coluna de outra unidade');
reset role; select tst.login('');
