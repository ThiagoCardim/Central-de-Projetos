-- =============================================================================
-- 0029 · Correção: etapa reaberta com início do retrabalho no futuro
--
-- A reabertura gravava a data futura como "início real"; ao concluir antes
-- dessa data o término real ficava antes do início e o banco recusava
-- (project_tasks_actual_chk).
--   * reopen_apply: início no futuro deixa a etapa "não iniciada" com
--     "não iniciar antes de" a data escolhida.
--   * set_task_status: início real nunca é gravado depois de hoje.
--   * Etapas que já ficaram com início real no futuro são corrigidas.
-- =============================================================================

create or replace function private.reopen_apply(p_task uuid, p_start date, p_days int, p_reason_id uuid, p_reason_text text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  t2 public.project_tasks;
  p public.projects;
  r public.schedule_change_reasons;
  cal uuid;
  v_start date;
  v_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_reason text;
  v_ids uuid[];
  c record;
begin
  t := private.task_for_edit(p_task, true);
  if t.status <> 'completed' then
    raise exception 'Só é possível reabrir etapas concluídas' using errcode = '23514';
  end if;
  if t.duration_type not in ('fixed', 'external') then
    raise exception 'Esta etapa não tem duração própria e não pode ser reaberta aqui' using errcode = '23514';
  end if;
  if p_days is null or p_days < 1 or p_days > 2000 then
    raise exception 'Informe o prazo do retrabalho: de 1 a 2000 dias úteis' using errcode = '23514';
  end if;
  if p_start is not null and p_start < current_date then
    raise exception 'O retrabalho não pode começar no passado' using errcode = '23514';
  end if;

  select * into r from public.schedule_change_reasons where id = p_reason_id and active;
  if r.id is null then
    raise exception 'Selecione o motivo da reabertura' using errcode = '23514';
  end if;
  if r.is_other then
    if v_text is null or length(v_text) < 3 then
      raise exception 'Descreva o motivo da reabertura' using errcode = '23514';
    end if;
    v_reason := v_text;
  else
    v_reason := r.label || coalesce(' · ' || v_text, '');
  end if;

  select * into p from public.projects where id = t.project_id;
  cal := private.calendar_for_tenant(p.delivery_tenant_id);
  v_start := public.next_business_day(coalesce(p_start, current_date), cal);

  perform set_config('youcon.reopen', 'on', true);
  perform private.engine_on();

  -- Empurrão: primeira etapa não iniciada de cada corrente, em todo o contrato.
  for c in
    with recursive cand as (
      select pt.id, pt.planned_start_date, pt.start_not_before
      from public.project_tasks pt
      where pt.project_id = t.project_id and pt.id <> t.id
        and pt.actual_start_date is null
        and pt.status not in ('completed', 'cancelled')
        and pt.planned_start_date is not null
    ),
    below(id) as (
      select d.task_id from public.task_dependencies d join cand x on d.depends_on_task_id = x.id
      union
      select d.task_id from public.task_dependencies d join below b on d.depends_on_task_id = b.id
    )
    select x.* from cand x where x.id not in (select id from below)
  loop
    update public.project_tasks
       set start_not_before = greatest(coalesce(c.start_not_before, c.planned_start_date),
                                       public.add_business_days(c.planned_start_date, p_days + 1, cal))
     where id = c.id;
  end loop;

  -- Retrabalho começa hoje: etapa em andamento. Começa numa data futura: volta a
  -- "não iniciada" com "não iniciar antes de" (início real só quando alguém iniciar).
  update public.project_tasks
     set status = case when v_start <= current_date then 'in_progress'::public.task_status else 'not_started'::public.task_status end,
         actual_start_date = case when v_start <= current_date then v_start end,
         actual_end_date = null,
         start_not_before = case when v_start <= current_date then start_not_before else v_start end,
         planned_start_date = v_start, planned_duration_days = p_days,
         planned_end_date = public.add_business_days(v_start, p_days, cal),
         waiting_reason = null,
         reopen_count = reopen_count + 1, last_reopened_at = v_start
   where id = t.id;

  v_ids := private.apply_schedule(t.project_id);
  select * into t2 from public.project_tasks where id = t.id;

  insert into public.task_changes (project_id, task_id, change_type, before, after, reason, reason_id, impacted_task_ids, changed_by)
  values (t.project_id, t.id, 'status', private.task_snapshot(t),
          private.task_snapshot(t2) || jsonb_build_object('reopened', true, 'rework_days', p_days, 'delay_days', p_days),
          v_reason, r.id, array_remove(v_ids, t.id), private.current_profile_id());

  if t2.responsible_user_id is not null then
    perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Etapa reaberta',
      t2.name || ' · ' || p.name || ' · ' || p_days || ' dias úteis de retrabalho', 'project_tasks', t2.id,
      '{}'::jsonb, null, t2.responsible_user_id);
  end if;

  return jsonb_build_object('impacted_count', coalesce(array_length(array_remove(v_ids, t.id), 1), 0),
                            'planned_start_date', t2.planned_start_date, 'planned_end_date', t2.planned_end_date);
end;
$$;

create or replace function private.set_task_status(p_task uuid, p_status public.task_status, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  t2 public.project_tasks;
  v_manager boolean;
  v_ids uuid[];
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  r record;
begin
  t := private.task_for_edit(p_task, false);
  v_manager := private.can_edit_schedule(t.project_id);

  if p_status = t.status then return jsonb_build_object('impacted_count', 0); end if;
  if p_status = 'overdue' then
    raise exception 'Atraso é calculado pelas datas; não é um status manual' using errcode = '23514';
  end if;
  if p_status in ('not_started', 'ready', 'cancelled') and not v_manager then
    raise exception 'Somente o gestor do projeto pode reabrir ou cancelar etapas' using errcode = '42501';
  end if;
  if p_status in ('waiting_client', 'waiting_third_party', 'waiting_dependency', 'cancelled') and v_reason is null then
    raise exception 'Descreva o motivo (ex.: o que está faltando)' using errcode = '23514';
  end if;
  if t.status = 'cancelled' and t.auto_skipped then
    raise exception 'Etapa dispensada porque o serviço predecessor não foi contratado' using errcode = '23514';
  end if;

  perform private.engine_on();
  update public.project_tasks set
    status = p_status,
    actual_start_date = case
      -- Início real nunca fica no futuro (ex.: etapa reaberta para começar depois).
      when p_status in ('in_progress', 'completed', 'waiting_client', 'waiting_third_party') then least(coalesce(actual_start_date, current_date), current_date)
      when p_status in ('not_started', 'ready') then null
      else actual_start_date end,
    actual_end_date = case
      when p_status = 'completed' then current_date
      else null end,
    waiting_reason = case
      when p_status in ('waiting_client', 'waiting_third_party', 'waiting_dependency', 'cancelled') then v_reason
      else null end
  where id = t.id;

  v_ids := private.apply_schedule(t.project_id);
  select * into t2 from public.project_tasks where id = t.id;

  insert into public.task_changes (project_id, task_id, change_type, before, after, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, 'status', private.task_snapshot(t), private.task_snapshot(t2), v_reason,
          array_remove(v_ids, t.id), private.current_profile_id());

  -- Etapas liberadas avisam seus responsáveis.
  if p_status = 'completed' then
    for r in
      select n.id, n.name, n.responsible_user_id, p.name as project_name, p.delivery_tenant_id
      from public.task_dependencies d
      join public.project_tasks n on n.id = d.task_id
      join public.projects p on p.id = n.project_id
      where d.depends_on_task_id = t.id and n.status = 'ready' and n.responsible_user_id is not null
    loop
      perform private.notify(r.delivery_tenant_id, 'task_ready', 'Etapa liberada para iniciar',
        r.name || ' · ' || r.project_name, 'project_tasks', r.id, '{}'::jsonb, null, r.responsible_user_id);
    end loop;
  end if;

  return jsonb_build_object('impacted_count', coalesce(array_length(array_remove(v_ids, t.id), 1), 0), 'status', t2.status);
end;
$$;


do $fix$
declare r record;
begin
  perform set_config('youcon.schedule_engine', 'on', true);
  for r in select distinct project_id from public.project_tasks
           where actual_start_date > current_date and status not in ('completed', 'cancelled')
  loop
    update public.project_tasks
       set status = 'not_started', start_not_before = actual_start_date, actual_start_date = null
     where project_id = r.project_id and actual_start_date > current_date and status not in ('completed', 'cancelled');
    perform private.apply_schedule(r.project_id);
  end loop;
end
$fix$;
