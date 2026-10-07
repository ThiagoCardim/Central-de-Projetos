-- =============================================================================
-- 0021 · Atraso empurra o contrato inteiro
--
-- Regra: quando uma alteração de prazo faz uma etapa terminar DEPOIS do previsto,
-- todas as etapas ainda não iniciadas do mesmo projeto (contrato) que estavam
-- previstas para começar depois do término antigo dessa etapa, em qualquer
-- serviço, andam o mesmo número de dias úteis. Antecipações não puxam as demais.
--
-- O empurrão vira um "não iniciar antes de" em cada etapa afetada, então o
-- motor continua respeitando dependências (o que for maior vale).
-- =============================================================================

-- Mapa de ajustes (overrides) para compute_schedule: a própria etapa + o empurrão.
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

  -- Etapas encadeadas à alterada (dependência direta ou indireta) já andam pelo
  -- motor e continuam podendo adiantar; a trava vale só para as demais.
  -- Também nos outros serviços, só a primeira etapa de cada corrente recebe a trava:
  -- as seguintes andam por dependência.
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
        and pt.planned_start_date > t.planned_end_date
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

-- Prévia com o empurrão no contrato.
create or replace function private.preview_task_change(p_task uuid, p_start date default null, p_duration int default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  ov jsonb := '{}'::jsonb;
  v_map jsonb;
  v_task jsonb;
  v_items jsonb;
  v_forecast_before date;
  v_forecast_after date;
begin
  t := private.task_for_edit(p_task, true);
  if p_start is not null and t.actual_start_date is not null then
    raise exception 'A etapa já começou: altere a duração em vez do início' using errcode = '23514';
  end if;
  if p_duration is not null and (p_duration < 1 or p_duration > 2000) then
    raise exception 'Duração deve ser de 1 a 2000 dias úteis' using errcode = '23514';
  end if;
  if p_duration is not null and t.duration_type not in ('fixed', 'external') then
    raise exception 'A duração desta etapa depende de outra etapa e não pode ser definida aqui' using errcode = '23514';
  end if;
  if p_start is not null then ov := jsonb_build_object('start', p_start); end if;
  if p_duration is not null then ov := ov || jsonb_build_object('duration', p_duration); end if;

  v_map := private.delay_cascade_overrides(t.id, ov);

  with calc as (
    select c.*, pt.name, pt.planned_start_date as os, pt.planned_end_date as oe, s.name as service_name,
           tr.id = (select schedule_track_id from public.project_tasks where id = t.id) as same_service
    from private.compute_schedule(t.project_id, v_map - '_delay_days') c
    join public.project_tasks pt on pt.id = c.task_id
    join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
    join public.project_services ps on ps.id = tr.project_service_id
    join public.services s on s.id = ps.service_id
  )
  select
    (select jsonb_build_object('id', c.task_id, 'name', c.name, 'service', c.service_name,
            'before_start', c.os, 'before_end', c.oe, 'after_start', c.new_start, 'after_end', c.new_end,
            'before_duration', t.planned_duration_days, 'after_duration', c.new_duration)
     from calc c where c.task_id = t.id),
    coalesce((select jsonb_agg(jsonb_build_object('id', c.task_id, 'name', c.name, 'service', c.service_name,
            'same_service', c.same_service,
            'before_start', c.os, 'before_end', c.oe, 'after_start', c.new_start, 'after_end', c.new_end)
            order by c.same_service desc, c.service_name, c.new_start nulls last, c.name)
     from calc c where c.task_id <> t.id and (c.new_start, c.new_end) is distinct from (c.os, c.oe)), '[]'::jsonb),
    (select max(c.oe) from calc c),
    (select max(c.new_end) from calc c)
  into v_task, v_items, v_forecast_before, v_forecast_after;

  return jsonb_build_object('task', v_task, 'impacted', v_items, 'impacted_count', jsonb_array_length(v_items),
                            'delay_days', coalesce((v_map ->> '_delay_days')::int, 0),
                            'other_services_count', (select count(distinct x ->> 'service') from jsonb_array_elements(v_items) x
                                                     where not (x ->> 'same_service')::boolean),
                            'forecast_before', v_forecast_before, 'forecast_after', v_forecast_after);
end;
$$;

-- Reprogramação: aplica a etapa e o empurrão no contrato.
create or replace function private.reschedule_task(p_task uuid, p_start date, p_duration int, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  t2 public.project_tasks;
  v_ids uuid[];
  ov jsonb := '{}'::jsonb;
  v_map jsonb;
  k text;
begin
  t := private.task_for_edit(p_task, true);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Informe o motivo da alteração de prazo' using errcode = '23514';
  end if;
  if p_start is null and p_duration is null then
    raise exception 'Informe a nova data de início ou a nova duração' using errcode = '23514';
  end if;
  perform private.preview_task_change(p_task, p_start, p_duration);  -- mesmas validações

  if p_start is not null then ov := jsonb_build_object('start', p_start); end if;
  if p_duration is not null then ov := ov || jsonb_build_object('duration', p_duration); end if;
  v_map := private.delay_cascade_overrides(t.id, ov);  -- calculado antes de mudar qualquer data

  perform private.engine_on();
  update public.project_tasks
     set start_not_before = coalesce(p_start, start_not_before),
         planned_duration_days = coalesce(p_duration, planned_duration_days)
   where id = t.id;

  for k in select jsonb_object_keys(v_map - '_delay_days' - t.id::text) loop
    update public.project_tasks
       set start_not_before = (v_map -> k ->> 'start')::date
     where id = k::uuid and project_id = t.project_id;
  end loop;

  v_ids := private.apply_schedule(t.project_id);
  select * into t2 from public.project_tasks where id = t.id;

  insert into public.task_changes (project_id, task_id, change_type, before, after, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, case when p_start is not null then 'reschedule' else 'duration' end,
          private.task_snapshot(t), private.task_snapshot(t2) || jsonb_build_object('delay_days', coalesce((v_map ->> '_delay_days')::int, 0)),
          trim(p_reason), array_remove(v_ids, t.id), private.current_profile_id());

  return jsonb_build_object('impacted_count', coalesce(array_length(array_remove(v_ids, t.id), 1), 0),
                            'planned_start_date', t2.planned_start_date, 'planned_end_date', t2.planned_end_date);
end;
$$;

revoke all on function private.delay_cascade_overrides(uuid, jsonb) from public, anon;
grant execute on function private.delay_cascade_overrides(uuid, jsonb) to authenticated;
