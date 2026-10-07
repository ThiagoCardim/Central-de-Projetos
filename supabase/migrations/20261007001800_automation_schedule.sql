-- Verificação de etapas atrasadas para as automações: a cada hora (minuto 7).
-- Só em ambientes com o agendador pg_cron (produção Supabase).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('youcon-automation-overdue', '7 * * * *', 'select private.automation_scan_overdue()');
  end if;
end $$;
