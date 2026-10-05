-- Vínculo automático entre perfil pendente e usuário criado no Auth.
\set ON_ERROR_STOP 1
set client_min_messages = notice;
insert into public.profiles (tenant_id, name, email, role)
values ('00000000-0000-4000-8000-000000000001', 'Primeiro Admin', 'admin@youcon.test', 'global_admin');
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000ad', 'Admin@YouCon.test');
do $$ begin
  if (select auth_user_id from public.profiles where email = 'admin@youcon.test') is distinct from '00000000-0000-4000-8000-0000000000ad' then
    raise exception 'FALHOU: perfil pendente não foi vinculado';
  end if;
  raise notice 'ok - convite vincula perfil pendente pelo e-mail';
end $$;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000ae', 'admin@youcon.test2');
do $$ begin
  if exists (select 1 from public.profiles where auth_user_id = '00000000-0000-4000-8000-0000000000ae') then
    raise exception 'FALHOU: vinculou e-mail diferente';
  end if;
  raise notice 'ok - e-mail sem perfil não vincula nada';
end $$;
