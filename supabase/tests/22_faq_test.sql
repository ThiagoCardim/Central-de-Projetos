-- FAQ: leitura para todos, edição só da administração global, retorno do leitor.
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

insert into auth.users (id, email) select gen_random_uuid(), e from unnest(array['ga@hq','ua@hq','cli@x']) e;
insert into public.profiles (tenant_id, name, email, role, employment_type, client_type)
values ('00000000-0000-4000-8000-000000000001', 'Global', 'ga@hq', 'global_admin', null, null),
       ('00000000-0000-4000-8000-000000000001', 'Admin', 'ua@hq', 'unit_admin', 'clt', null),
       ('00000000-0000-4000-8000-000000000001', 'Cliente', 'cli@x', 'client', null, 'b2c');
update public.profiles p set auth_user_id = u.id from auth.users u where u.email = p.email and p.auth_user_id is null;

select tst.ok((select count(*) from public.faq_categories) = 16, '16 categorias');
select tst.ok((select count(*) from public.faq_items) = 173, '173 perguntas');
select tst.ok(not exists (select 1 from public.faq_items where category_id is null), 'Toda pergunta tem categoria');

select tst.login('cli@x'); set role authenticated;
select tst.ok((select count(*) from public.faq_items) = 173, 'Cliente lê o FAQ');
select tst.throws($$select public.faq_item_save(null, (select id from public.faq_categories limit 1), 'Pergunta nova?', 'Resposta', null)$$, 'Cliente não edita');
select public.faq_feedback_add((select id from public.faq_items order by sort_order limit 1), false, 'quanto custa o alvará?');
select tst.ok((select count(*) from public.faq_feedback) = 0, 'Cliente não vê os retornos');
reset role;
select tst.ok((select count(*) from public.faq_feedback where not helpful and query like 'quanto%') = 1, 'Retorno do leitor é guardado');

select tst.login('ua@hq'); set role authenticated;
select tst.throws($$select public.faq_category_save(null, 'Nova')$$, 'ADM da unidade não edita o FAQ');
reset role;

select tst.login('ga@hq'); set role authenticated;
select public.faq_item_save(null, (select id from public.faq_categories where sort_order = 90), 'Quanto custa o alvará?', 'Depende da prefeitura e da área.', 'alvara, valor, preço');
select tst.ok((select count(*) from public.faq_items where archived_at is null) = 174, 'ADM global inclui pergunta');
select public.faq_item_archive((select id from public.faq_items where question = 'Quanto custa o alvará?'));
reset role;
select tst.login('cli@x'); set role authenticated;
select tst.ok((select count(*) from public.faq_items) = 173, 'Pergunta excluída some para o cliente');
select tst.throws($$select public.faq_category_archive((select id from public.faq_categories where sort_order = 10))$$, 'Cliente não exclui categoria');
reset role;
select tst.login('ga@hq'); set role authenticated;
select tst.throws($$select public.faq_category_archive((select id from public.faq_categories where sort_order = 10))$$, 'Categoria com perguntas não é excluída');
reset role;
