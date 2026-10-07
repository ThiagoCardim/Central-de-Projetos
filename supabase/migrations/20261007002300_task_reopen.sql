-- =============================================================================
-- 0023 · Reabertura de etapa concluída
--
-- Quando o cliente pede alteração em algo já entregue, o gestor reabre a etapa
-- informando quando o retrabalho começa e quantos dias úteis ele leva (N).
--   * A etapa volta para "em andamento" a partir da data do retrabalho.
--   * Etapas seguintes que dependem dela andam pelo motor.
--   * Toda etapa ainda não iniciada do contrato, em qualquer serviço, anda N
--     dias úteis (mesma regra do atraso). Etapas em andamento/concluídas não mudam.
--   * Motivo da lista de motivos (o cliente vê, se o motivo for visível).
--   * Reabrir só por esta função: status concluído não volta por outro caminho.
-- =============================================================================

alter table public.project_tasks add column if not exists reopen_count int not null default 0;
alter table public.project_tasks add column if not exists last_reopened_at date;

insert into public.schedule_change_reasons (label, client_visible, is_other, sort_order)
values ('Cliente pediu alteração em etapa já concluída', true, false, 15)
on conflict do nothing;

-- Concluída só volta a abrir por reopen_task.
create or replace function private.guard_task_reopen()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if old.status = 'completed' and new.status <> 'completed'
     and coalesce(current_setting('youcon.reopen', true), '') <> 'on' then
    raise exception 'Para reabrir uma etapa concluída, use "Reabrir etapa" e informe o motivo e o prazo do retrabalho'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger project_tasks_reopen_guard before update of status on public.project_tasks
  for each row execute function private.guard_task_reopen();

-- Núcleo: aplica a reabertura e devolve os dados do registro.
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

  update public.project_tasks
     set status = 'in_progress',
         actual_start_date = v_start, actual_end_date = null,
         planned_start_date = v_start, planned_duration_days = p_days,
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

-- Prévia: aplica numa subtransação, mede o impacto e desfaz tudo.
create or replace function private.preview_task_reopen(p_task uuid, p_start date, p_days int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  v_reason uuid;
  v_before jsonb;
  v_out jsonb;
  v_msg text;
begin
  t := private.task_for_edit(p_task, true);
  select id into v_reason from public.schedule_change_reasons where active and not is_other order by sort_order limit 1;
  select jsonb_object_agg(id::text, jsonb_build_object('s', planned_start_date, 'e', planned_end_date))
    into v_before from public.project_tasks where project_id = t.project_id;

  begin
    perform private.reopen_apply(p_task, p_start, p_days, v_reason, null);

    with calc as (
      select pt.id, pt.name, pt.planned_start_date as ns, pt.planned_end_date as ne, pt.planned_duration_days as nd,
             (v_before -> pt.id::text ->> 's')::date as os, (v_before -> pt.id::text ->> 'e')::date as oe,
             s.name as service_name, pt.schedule_track_id = t.schedule_track_id as same_service
      from public.project_tasks pt
      join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
      join public.project_services ps on ps.id = tr.project_service_id
      join public.services s on s.id = ps.service_id
      where pt.project_id = t.project_id
    )
    select jsonb_build_object(
      'task', (select jsonb_build_object('id', c.id, 'name', c.name, 'service', c.service_name,
                 'before_start', coalesce(t.actual_start_date, t.planned_start_date), 'before_end', coalesce(t.actual_end_date, t.planned_end_date),
                 'after_start', c.ns, 'after_end', c.ne, 'before_duration', t.planned_duration_days, 'after_duration', c.nd)
               from calc c where c.id = t.id),
      'impacted', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'service', c.service_name,
                 'same_service', c.same_service, 'before_start', c.os, 'before_end', c.oe, 'after_start', c.ns, 'after_end', c.ne)
                 order by c.same_service desc, c.service_name, c.ns nulls last, c.name)
               from calc c where c.id <> t.id and (c.ns, c.ne) is distinct from (c.os, c.oe)), '[]'::jsonb),
      'delay_days', p_days,
      'forecast_before', (select max(c.oe) from calc c),
      'forecast_after', (select max(c.ne) from calc c)
    ) into v_out;
    v_out := v_out || jsonb_build_object(
      'impacted_count', jsonb_array_length(v_out -> 'impacted'),
      'other_services_count', (select count(distinct x ->> 'service') from jsonb_array_elements(v_out -> 'impacted') x
                               where not (x ->> 'same_service')::boolean));
    raise exception using errcode = 'YC001', message = v_out::text;
  exception when sqlstate 'YC001' then
    get stacked diagnostics v_msg = message_text;
    return v_msg::jsonb;
  end;
end;
$$;

create or replace function public.preview_task_reopen(p_task uuid, p_start date, p_days int) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.preview_task_reopen(p_task, p_start, p_days) $$;
create or replace function public.reopen_task(p_task uuid, p_start date, p_days int, p_reason_id uuid, p_reason_text text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.reopen_apply(p_task, p_start, p_days, p_reason_id, p_reason_text) $$;

-- Cliente: reaberturas aparecem no histórico de prazos.
create or replace function private.client_schedule_changes(p_project uuid default null, p_limit int default 50)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'changed_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', c.id,
      'project_id', c.project_id,
      'project_name', p.name,
      'task_name', t.name,
      'service_name', s.name,
      'change_type', case when c.change_type = 'status' then 'reopened' else c.change_type end,
      'reason', case when r.is_other or r.id is null then c.reason else r.label end,
      'reason_detail', case when r.id is not null and not r.is_other and c.reason like r.label || ' · %'
                            then substr(c.reason, length(r.label) + 4) end,
      'before_start', coalesce(c.before ->> 'actual_start_date', c.before ->> 'planned_start_date'),
      'before_end', case when c.change_type = 'status' then coalesce(c.before ->> 'actual_end_date', c.before ->> 'planned_end_date')
                         else c.before ->> 'planned_end_date' end,
      'after_start', c.after ->> 'planned_start_date',
      'after_end', c.after ->> 'planned_end_date',
      'impacted_count', coalesce(array_length(c.impacted_task_ids, 1), 0),
      'changed_at', c.created_at
    ) as x
    from public.task_changes c
    join public.projects p on p.id = c.project_id
    join public.project_tasks t on t.id = c.task_id
    left join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
    left join public.project_services ps on ps.id = tr.project_service_id
    left join public.services s on s.id = ps.service_id
    left join public.schedule_change_reasons r on r.id = c.reason_id
    where (c.change_type in ('reschedule', 'duration')
           or (c.change_type = 'status' and coalesce((c.after ->> 'reopened')::boolean, false)))
      and t.client_visible
      and coalesce(r.client_visible, true)
      and (p_project is null or c.project_id = p_project)
      and private.can_view_project(c.project_id)
    order by c.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) q
$$;

revoke all on function private.reopen_apply(uuid, date, int, uuid, text) from public, anon;
revoke all on function private.preview_task_reopen(uuid, date, int) from public, anon;
revoke all on function public.preview_task_reopen(uuid, date, int) from public, anon;
revoke all on function public.reopen_task(uuid, date, int, uuid, text) from public, anon;
grant execute on function private.reopen_apply(uuid, date, int, uuid, text) to authenticated;
grant execute on function private.preview_task_reopen(uuid, date, int) to authenticated;
grant execute on function public.preview_task_reopen(uuid, date, int) to authenticated;
grant execute on function public.reopen_task(uuid, date, int, uuid, text) to authenticated;
