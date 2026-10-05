-- =============================================================================
-- Portal de Projetos YouCon — Migration 0006: endurecimento de privilégios
--
-- O Supabase concede por padrão ALL (inclusive TRUNCATE, que ignora RLS) a
-- anon/authenticated em toda tabela nova do schema public. Aqui reduzimos ao
-- mínimo: anon não acessa nada; authenticated nunca trunca nem cria triggers.
-- =============================================================================

-- Visitantes não autenticados não acessam nenhuma tabela, view ou sequência.
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;

-- TRUNCATE/REFERENCES/TRIGGER não fazem sentido para usuários do app.
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- Tabelas sem política de DELETE (registros são desativados, nunca apagados).
revoke delete on public.tenants, public.profiles, public.clients, public.audit_logs,
                 public.project_intakes, public.projects, public.project_allocations,
                 public.project_team, public.notifications, public.allocation_methods,
                 public.task_changes
  from authenticated;

-- Escrita direta proibida (somente via funções/RPC security definer ou service_role).
revoke insert, update on public.audit_logs, public.project_intakes, public.project_allocations,
                         public.task_changes
  from authenticated;
revoke insert on public.projects, public.notifications from authenticated;

-- Funções públicas: nenhuma executável por anon (o PostgREST expõe o schema public).
revoke execute on all functions in schema public from anon, public;
grant execute on function
  public.my_permissions(),
  public.get_home_dashboard(),
  public.client_projects_overview(),
  public.tenant_overview(),
  public.admin_prepare_user(uuid, text, text, public.user_role, public.employment_type, public.client_type, uuid, text),
  public.admin_update_user(uuid, text, public.user_role, public.employment_type, public.client_type, text, uuid),
  public.admin_set_user_status(uuid, public.record_status),
  public.admin_create_tenant(text, text, text, text),
  public.next_business_day(date, uuid),
  public.add_business_days(date, int, uuid),
  public.business_days_between(date, date, uuid)
  to authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- Objetos criados no futuro também nascem fechados para anon.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon, public;
