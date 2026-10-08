-- Performance do time: nota composta, visibilidade CLT/PJ, destaques e configuração.
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
-- Mês anterior (fechado), para o teste não depender do dia de hoje.
create function tst.pm() returns date language sql as $$ select (date_trunc('month', (now() at time zone 'America/Sao_Paulo')::date) - interval '1 month')::date $$;
create function tst.at(p_day date) returns timestamptz language sql as $$ select (p_day + time '12:00') at time zone 'America/Sao_Paulo' $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['lid@hq','arq@hq','pj@hq','eng@hq','adm@hq']) e;
create function tst.sec(p_name text) returns uuid language sql as $$ select id from public.sectors where tenant_id = '00000000-0000-4000-8000-000000000001' and name = p_name $$;
grant execute on function tst.sec(text) to authenticated;
insert into public.profiles (tenant_id, name, email, role, employment_type, sector_id)
values ('00000000-0000-4000-8000-000000000001', 'Líder', 'lid@hq', 'leader', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Ana Arquiteta', 'arq@hq', 'collaborator', 'clt', tst.sec('Arquitetura')),
       ('00000000-0000-4000-8000-000000000001', 'Paulo PJ', 'pj@hq', 'collaborator', 'pj', tst.sec('Arquitetura')),
       ('00000000-0000-4000-8000-000000000001', 'Eduarda Eng', 'eng@hq', 'collaborator', 'clt', tst.sec('Engenharia')),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'adm@hq', 'unit_admin', 'clt', null);
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

set role service_role;
select public.ingest_crm_webhook('pipefy', '{"card_id": "9701", "cliente": {"nome": "Ana", "email": "ana@exemplo.com", "tipo": "B2C"},
  "projeto": {"nome": "Casa Perf", "area_m2": "150"}, "servicos": "Projeto Arquitetônico", "data_fechamento": "01/09/2026"}'::jsonb);
reset role;
select tst.login('lid@hq'); set role authenticated;
select public.assign_project_team((select id from public.projects where external_id = '9701'), jsonb_build_array(
  jsonb_build_object('project_role', 'lead_architecture', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_engineering', 'user_id', tst.uid('lid@hq')),
  jsonb_build_object('project_role', 'lead_approval', 'user_id', tst.uid('lid@hq'))));
reset role;

-- Dados do mês anterior (feito direto no banco, sem usuário logado)
select tst.login('');
update public.project_tasks t set responsible_user_id = tst.uid('arq@hq'), planned_end_date = tst.pm() + 2, actual_end_date = tst.pm() + 2,
       status = 'completed', planned_start_date = tst.pm()
  from public.projects p where p.id = t.project_id and p.external_id = '9701' and t.code = 'planejamento';
update public.project_tasks t set responsible_user_id = tst.uid('arq@hq'), planned_end_date = tst.pm() + 5, actual_end_date = tst.pm() + 8,
       status = 'completed', planned_start_date = tst.pm()
  from public.projects p where p.id = t.project_id and p.external_id = '9701' and t.code = 'envio_briefing';
-- Ana: 1 tarefa da liderança no prazo, 1 em aberto vencida; 1 pessoal (não conta)
insert into public.work_items (owner_id, title, due_date, done_at, assigned_by, assigned_at) values
  (tst.uid('arq@hq'), 'Revisar memorial', tst.pm() + 10, tst.at(tst.pm() + 9), tst.uid('lid@hq'), now()),
  (tst.uid('arq@hq'), 'Organizar acervo', tst.pm() + 12, null, tst.uid('lid@hq'), now()),
  (tst.uid('arq@hq'), 'Pessoal', tst.pm() + 3, null, null, null);
-- Paulo (PJ) e Eduarda (CLT): 3 tarefas no prazo cada
insert into public.work_items (owner_id, title, due_date, done_at, assigned_by, assigned_at)
select o, 'T' || i, tst.pm() + i, tst.at(tst.pm() + i), tst.uid('lid@hq'), now()
from unnest(array[tst.uid('pj@hq'), tst.uid('eng@hq')]) o, generate_series(1, 3) i;

create function tst.row(p jsonb, p_email text) returns jsonb language sql as $$
  select r from jsonb_array_elements(p -> 'people') r where r ->> 'id' = tst.uid(p_email)::text $$;
grant execute on function tst.row(jsonb, text) to authenticated;

-- Líder: vê a equipe inteira, inclusive PJ
select tst.login('lid@hq'); set role authenticated;
create temp table ov as select public.performance_overview(tst.pm()) as j;
select tst.ok((select j ->> 'scope' from ov) = 'team', 'Líder vê a visão da equipe');
select tst.ok((select jsonb_array_length(j -> 'people') from ov) = 4, 'Líder vê 4 pessoas (equipe e ele mesmo)');
select tst.ok((select tst.row(j, 'arq@hq') ->> 'planned' from ov) = '4', 'Ana: 4 previstas (2 etapas + 2 tarefas da liderança; pessoal não conta)');
select tst.ok((select tst.row(j, 'arq@hq') ->> 'delivered' from ov) = '3', 'Ana: 3 entregues');
select tst.ok((select tst.row(j, 'arq@hq') ->> 'on_time' from ov) = '2', 'Ana: 2 no prazo');
select tst.ok((select tst.row(j, 'arq@hq') ->> 'late_open' from ov) = '1', 'Ana: 1 em atraso aberta');
select tst.ok((select tst.row(j, 'arq@hq') ->> 'score' from ov) = '73', 'Ana: nota composta 73 (60×75% + 30×67% + 10×75%)');
select tst.ok((select tst.row(j, 'arq@hq') ->> 'band' from ov) = 'ok', 'Ana: faixa satisfatória');
select tst.ok((select tst.row(j, 'pj@hq') ->> 'score' from ov) = '100', 'Líder vê a performance do PJ');
select tst.ok((select jsonb_array_length(public.performance_person(tst.uid('pj@hq'), tst.pm()) -> 'delivered')) = 3, 'Líder abre o detalhe do PJ');
select tst.throws(format('select public.save_performance_settings(%L, %L::jsonb)', '00000000-0000-4000-8000-000000000001', '{}'), 'Líder não altera as regras');
select public.set_profile_sector(tst.uid('eng@hq'), tst.sec('Interiores'));
reset role;
select tst.ok((select s.name from public.profiles p join public.sectors s on s.id = p.sector_id where email = 'eng@hq') = 'Interiores', 'Gestão define o setor');
update public.profiles set sector_id = tst.sec('Engenharia') where email = 'eng@hq';

-- CLT: vê só a própria performance e os destaques
select tst.login('arq@hq'); set role authenticated;
select tst.ok(public.performance_overview(tst.pm()) ->> 'scope' = 'self', 'CLT vê a própria visão');
select tst.ok(jsonb_array_length(public.performance_overview(tst.pm()) -> 'people') = 1, 'CLT não vê a equipe');
select tst.ok((public.performance_person(tst.uid('arq@hq'), tst.pm()) -> 'person' ->> 'score') = '73', 'CLT abre a própria performance');
select tst.ok(jsonb_array_length(public.performance_person(tst.uid('arq@hq'), tst.pm()) -> 'late') = 1, 'Lista a tarefa em atraso');
select tst.throws(format('select public.performance_person(%L, %L)', tst.uid('pj@hq'), tst.pm()), 'CLT não vê a performance de colega');
select tst.ok((public.my_permissions() ->> 'can_view_performance')::boolean, 'Permissão de ver performance para CLT');
create temp table hl as select public.performance_highlights(tst.pm()) as j;
select tst.ok((select x -> 'person' ->> 'name' from hl, jsonb_array_elements(j -> 'items') x where x -> 'sector' ->> 'name' = 'Arquitetura') = 'Ana Arquiteta',
  'Destaque de Arquitetura é a Ana (PJ fora do destaque por padrão)');
select tst.ok((select x -> 'person' ->> 'name' from hl, jsonb_array_elements(j -> 'items') x where x -> 'sector' ->> 'name' = 'Engenharia') = 'Eduarda Eng',
  'Destaque de Engenharia é a Eduarda');
select tst.throws(format('select public.set_profile_sector(%L, null)', tst.uid('pj@hq')), 'Colaborador não define setor');
reset role;

-- PJ: medido, mas não vê a própria performance
select tst.login('pj@hq'); set role authenticated;
select tst.throws(format('select public.performance_overview(%L)', tst.pm()), 'PJ não abre a performance');
select tst.throws(format('select public.performance_person(%L, %L)', tst.uid('pj@hq'), tst.pm()), 'PJ não vê a própria nota');
select tst.ok(public.performance_highlights(tst.pm()) is null, 'PJ não vê destaques');
select tst.ok(not (public.my_permissions() ->> 'can_view_performance')::boolean, 'Permissão negada para PJ');
reset role;

-- ADM da unidade ajusta as regras: PJ entra no destaque
select tst.login('adm@hq'); set role authenticated;
select public.save_performance_settings('00000000-0000-4000-8000-000000000001', '{"weight_delivery": 60, "weight_on_time": 30,
  "weight_no_backlog": 10, "band_ok": 70, "band_great": 90, "min_volume": 3, "include_assigned_tasks": true, "highlight_includes_pj": true}');
select tst.ok((select x -> 'person' ->> 'name' from jsonb_array_elements(public.performance_highlights(tst.pm()) -> 'items') x
  where x -> 'sector' ->> 'name' = 'Arquitetura') = 'Paulo PJ', 'Com PJ no destaque, Paulo (100) passa a Ana');
select tst.throws(format('select public.save_performance_settings(%L, %L::jsonb)', '00000000-0000-4000-8000-000000000001',
  '{"weight_delivery": 60, "weight_on_time": 30, "weight_no_backlog": 10, "band_ok": 90, "band_great": 70, "min_volume": 3,
    "include_assigned_tasks": true, "highlight_includes_pj": true}'), 'Faixas inválidas são recusadas');
select public.save_performance_settings('00000000-0000-4000-8000-000000000001', '{"weight_delivery": 100, "weight_on_time": 0,
  "weight_no_backlog": 0, "band_ok": 70, "band_great": 90, "min_volume": 3, "include_assigned_tasks": true, "highlight_includes_pj": false}');
select tst.ok((tst.row(public.performance_overview(tst.pm()), 'arq@hq') ->> 'score') = '75', 'Pesos novos: só cumprimento = 75');
reset role;

-- Cadastro de setores: só a administração
select tst.login('lid@hq'); set role authenticated;
select tst.throws($$select public.sector_save('00000000-0000-4000-8000-000000000001', null, 'Orçamentos')$$, 'Líder não cria setor');
select tst.throws(format('select public.sector_delete(%L)', tst.sec('Interiores')), 'Líder não exclui setor');
reset role;
select tst.login('adm@hq'); set role authenticated;
select public.sector_save('00000000-0000-4000-8000-000000000001', null, 'Orçamentos');
select tst.ok(jsonb_array_length(public.sector_list('00000000-0000-4000-8000-000000000001')) = 5, 'ADM cria setor');
select tst.throws($$select public.sector_save('00000000-0000-4000-8000-000000000001', null, 'orçamentos')$$, 'Nome repetido é recusado');
select public.sector_save(null, tst.sec('Aprovação'), 'Aprovações');
select tst.ok(tst.sec('Aprovações') is not null, 'ADM renomeia setor');
select public.sector_reorder('00000000-0000-4000-8000-000000000001', array[tst.sec('Orçamentos'), tst.sec('Arquitetura')]);
select tst.ok((public.sector_list('00000000-0000-4000-8000-000000000001') -> 0 ->> 'name') = 'Orçamentos', 'ADM reordena');
select tst.ok(public.sector_delete(tst.sec('Arquitetura')) = 2, 'Excluir informa quantas pessoas ficam sem setor');
select tst.ok(jsonb_array_length(public.sector_list('00000000-0000-4000-8000-000000000001')) = 4, 'Setor excluído some da lista');
select tst.ok(public.sector_save('00000000-0000-4000-8000-000000000001', null, 'Arquitetura') = tst.sec('Arquitetura'), 'Incluir o mesmo nome reativa o setor');
reset role;
select tst.ok((select sector_id from public.profiles where email = 'arq@hq') is null, 'Pessoas do setor excluído ficam sem setor');
select tst.throws(format('select private.set_person_sector(%L, %L)', tst.uid('arq@hq'), gen_random_uuid()), 'Setor de outra unidade é recusado');
