-- Venda vincula o acesso do cliente pelo e-mail; CPF de outro cliente vai para revisão.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tst;
grant usage on schema tst to authenticated, service_role;
create function tst.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'FALHOU: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;
create function tst.login(p_email text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',
    coalesce((select auth_user_id::text from public.profiles where email = p_email), ''), false);
end $$;
grant execute on all functions in schema tst to authenticated, service_role;

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','isa@x','ana@x','novo@x']) e;
insert into public.profiles (tenant_id, name, email, role)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
create function tst.sale(p_name text, p_email text, p_doc text) returns jsonb language sql as $$
  select public.create_manual_intake(jsonb_build_object('tipo', 'novo_projeto',
    'cliente', jsonb_build_object('nome', p_name, 'tipo', 'b2c', 'email', p_email, 'documento', p_doc),
    'projeto', jsonb_build_object('nome', 'Casa ' || p_name, 'tipo', 'Residencial', 'cidade', 'Poços de Caldas', 'uf', 'MG', 'area_m2', '200'),
    'servicos', 'Projeto Arquitetônico', 'tenant_id', '00000000-0000-4000-8000-000000000001', 'data_fechamento', '2026-10-07'))
$$;
grant execute on all functions in schema tst to authenticated;

select tst.login('ga@hq'); set role authenticated;
-- Cenário do relato: venda anterior com o CPF 087.187.246-39 para "Thiago"
select tst.sale('Thiago', 'thiago@x', '08718724639');
-- Cliente "Isabel" convidada pelo Controle de Acessos (cliente criado junto)
insert into public.clients (tenant_id, name, email, client_type) values ('00000000-0000-4000-8000-000000000001', 'Isabel', 'isa@x', 'b2c');
select public.admin_prepare_user('00000000-0000-4000-8000-000000000001', 'Isabel', 'isa@x', 'client', null, 'b2c',
  (select id from public.clients where email = 'isa@x'));
reset role; select tst.login('');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

select tst.ok((select count(*) from public.client_contacts where profile_id = (select id from public.profiles where email = 'isa@x')) = 1,
  'Convite cria um único vínculo (sem duplicar com o automático)');

-- Venda da Isabel digitada com o CPF do Thiago: não pode cair no cliente do Thiago
select tst.login('ga@hq'); set role authenticated;
create temp table r1 as select tst.sale('Isabel', 'isa@x', '08718724639') as j;
reset role;
select tst.ok((select j ->> 'status' from r1) = 'error', 'CPF de outro cliente com e-mail diferente: entrada vai para revisão');
select tst.ok((select validation_error from public.project_intakes order by received_at desc limit 1) like '%pertence ao cliente "Thiago"%',
  'Mensagem explica o conflito');
select tst.ok(not exists (select 1 from public.projects where name = 'Casa Isabel'), 'Nada foi criado');

-- Corrigido (sem CPF): projeto vai para a Isabel e ela vê
select tst.login('ga@hq'); set role authenticated;
select public.reprocess_intake((select id from public.project_intakes order by received_at desc limit 1), '{"client_document": ""}'::jsonb);
reset role;
select tst.ok((select c.email from public.projects p join public.clients c on c.id = p.client_id where p.name = 'Casa Isabel') = 'isa@x',
  'Projeto vinculado ao cliente do e-mail');
select tst.login('isa@x'); set role authenticated;
select tst.ok(exists (select 1 from public.projects where name = 'Casa Isabel'), 'Cliente vê o projeto com o e-mail da venda');
select tst.ok(not exists (select 1 from public.projects where name = 'Casa Thiago'), 'Cliente não vê projeto de outro cliente');
reset role;

-- Venda antes do convite: o convite posterior já dá acesso
select tst.login('ga@hq'); set role authenticated;
select tst.sale('Ana', 'ana@x', null);
select tst.ok(exists (select 1 from public.client_contacts cc join public.clients c on c.id = cc.client_id where c.email = 'ana@x' and cc.email = 'ana@x'),
  'Venda cria o contato com o e-mail do cliente');
select public.admin_prepare_user('00000000-0000-4000-8000-000000000001', 'Ana', 'ana@x', 'client', null, 'b2c',
  (select id from public.clients where email = 'ana@x'));
reset role; select tst.login('');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;
select tst.login('ana@x'); set role authenticated;
select tst.ok(exists (select 1 from public.projects where name = 'Casa Ana'), 'Convite depois da venda: cliente vê o projeto');
reset role;

-- Usuário cliente já existe e chega uma venda nova com o e-mail dele
select tst.login('ga@hq'); set role authenticated;
select tst.sale('Ana', 'ana@x', null);
reset role;
select tst.login('ana@x'); set role authenticated;
select tst.ok((select count(*) from public.projects where name = 'Casa Ana') = 2, 'Segunda venda com o mesmo e-mail aparece para o cliente');
reset role;

-- Mesmo CPF e mesmo e-mail: reaproveita o cliente
select tst.login('ga@hq'); set role authenticated;
select tst.sale('Thiago', 'thiago@x', '08718724639');
reset role;
select tst.ok((select count(*) from public.clients where document = '08718724639') = 1, 'Mesmo CPF e e-mail: mesmo cliente');
