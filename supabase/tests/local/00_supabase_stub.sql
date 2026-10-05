-- Stub mínimo do ambiente Supabase para rodar migrations e testes de RLS num
-- Postgres puro (CI/local). NÃO aplicar em um projeto Supabase real.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')                then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated')       then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')        then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth, extensions, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role, supabase_auth_admin;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role, authenticated;
