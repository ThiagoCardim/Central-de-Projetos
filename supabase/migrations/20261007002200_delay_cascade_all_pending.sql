-- =============================================================================
-- 0022 · Atraso empurra TODAS as etapas não iniciadas do contrato
--
-- Regra (definida pela YouCon): quando uma etapa atrasa N dias úteis, toda etapa
-- ainda não iniciada do mesmo projeto (contrato), em qualquer serviço e em
-- qualquer data, anda N dias úteis. Etapas em andamento ou concluídas não mudam.
-- Antecipações continuam sem puxar as demais.
--
-- A trava ("não iniciar antes de") vai só na primeira etapa de cada corrente;
-- as seguintes andam por dependência. Etapas encadeadas à alterada andam pelo motor.
-- =============================================================================
create or replace function private.delay_cascade_overrides(p_task uuid, p_ov jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  p public.projects;
  cal uuid;
  v_new_end date;
  v_delta int := 0;
  v_map jsonb;
  r record;
begin
  select * into t from public.project_tasks where id = p_task;
  select * into p from public.projects where id = t.project_id;
  cal := private.calendar_for_tenant(p.delivery_tenant_id);
  v_map := jsonb_build_object(t.id::text, coalesce(p_ov, '{}'::jsonb));

  select c.new_end into v_new_end
  from private.compute_schedule(t.project_id, v_map) c where c.task_id = t.id;

  if t.planned_end_date is null or v_new_end is null or v_new_end <= t.planned_end_date then
    return v_map;  -- sem atraso: nada a empurrar
  end if;
  v_delta := public.business_days_between(t.planned_end_date + 1, v_new_end, cal);
  if v_delta <= 0 then return v_map; end if;

  for r in
    with recursive downstream(id) as (
      select d.task_id from public.task_dependencies d where d.depends_on_task_id = t.id
      union
      select d.task_id from public.task_dependencies d join downstream x on d.depends_on_task_id = x.id
    ),
    cand as (
      select pt.id, pt.planned_start_date, pt.start_not_before
      from public.project_tasks pt
      where pt.project_id = t.project_id
        and pt.id <> t.id
        and pt.id not in (select id from downstream)
        and pt.actual_start_date is null
        and pt.status not in ('completed', 'cancelled')
        and pt.planned_start_date is not null
    ),
    below(id) as (
      select d.task_id from public.task_dependencies d join cand c on d.depends_on_task_id = c.id
      union
      select d.task_id from public.task_dependencies d join below b on d.depends_on_task_id = b.id
    )
    select c.* from cand c where c.id not in (select id from below)
  loop
    v_map := v_map || jsonb_build_object(r.id::text, jsonb_build_object('start',
      greatest(coalesce(r.start_not_before, r.planned_start_date),
               public.add_business_days(r.planned_start_date, v_delta + 1, cal))));
  end loop;
  return v_map || jsonb_build_object('_delay_days', v_delta);
end;
$$;
