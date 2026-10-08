-- Remove os dados FICTÍCIOS de demonstração criados por performance_demo_seed.sql.
-- Só apaga o que está marcado como demo (external_source = 'demo' e títulos "(demo)").
-- Os setores definidos nas pessoas são mantidos (ajuste na aba Equipe).
begin;
delete from public.work_items where title like '% (demo)';
delete from public.task_changes where project_id in (select id from public.projects where external_source = 'demo');
delete from public.project_tasks where project_id in (select id from public.projects where external_source = 'demo');
delete from public.project_schedule_tracks where project_id in (select id from public.projects where external_source = 'demo');
delete from public.project_services where project_id in (select id from public.projects where external_source = 'demo');
delete from public.projects where external_source = 'demo';
delete from public.clients where external_source = 'demo';
commit;
