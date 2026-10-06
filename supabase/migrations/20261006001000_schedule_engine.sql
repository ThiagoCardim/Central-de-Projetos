-- =============================================================================
-- Portal de Projetos YouCon — Migration 0010 (Etapa 3): Motor de cronograma.
--
--   * Escolha do template vigente por serviço, tipo de cliente (B2C/B2B) e área.
--   * Geração de trilhas e etapas quando o projeto inicia (equipe confirmada) e
--     quando um serviço adicional é ativado — sem reiniciar o que já existe.
--   * Dependências dentro da trilha e entre serviços (resolvidas pelo template;
--     ignoradas quando o serviço predecessor não foi contratado).
--   * Recálculo em dias úteis (calendário da unidade executora), com prévia de
--     impacto: nada muda sem confirmação e motivo.
--   * Ações de etapa (status, responsável, prazo, dependências) com histórico.
--   * Gerenciador de templates: rascunho → publicação de nova versão. Projetos
--     já gerados guardam a versão usada e não mudam.
--
-- Regras de prazo: só os prazos fornecidos pela YouCon. Etapa sem duração fica
-- "a definir" e as etapas seguintes ficam sem data até alguém definir — nunca
-- inventamos datas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Colunas de apoio
-- -----------------------------------------------------------------------------
alter table public.project_schedule_tracks
  add column base_date   date,   -- data mínima de início da trilha (início do projeto ou ativação do serviço)
  add column status_note text;   -- explicação para "sem template" / "aguardando área"

alter table public.project_tasks
  add column start_not_before date,                        -- reprogramação manual ("não iniciar antes de")
  add column auto_skipped     boolean not null default false; -- etapa "dependente" sem serviço predecessor contratado

-- -----------------------------------------------------------------------------
-- O motor de cronograma atualiza etapas de várias pessoas em nome de quem fez a
-- ação. A guarda de escrita libera somente quando o motor está ativo nesta
-- transação (flag local definida pelas funções privadas abaixo).
-- -----------------------------------------------------------------------------
create or replace function private.guard_task_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  allowed constant text[] := array['status','actual_start_date','actual_end_date','notes','waiting_reason','updated_at','status_changed_at'];
  k text;
begin
  if auth.uid() is null
     or coalesce(current_setting('youcon.schedule_engine', true), '') = 'on'
     or private.can_edit_schedule(old.project_id) then
    return new;
  end if;
  if old.responsible_user_id is distinct from private.current_profile_id() then
    raise exception 'Sem permissão para alterar esta etapa' using errcode = '42501';
  end if;
  for k in select jsonb_object_keys(to_jsonb(new)) loop
    if not (k = any (allowed)) and (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'Você pode atualizar apenas status, datas reais e observações desta etapa' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

create or replace function private.engine_on() returns void
language sql set search_path = ''
as $$ select set_config('youcon.schedule_engine', 'on', true) $$;

-- -----------------------------------------------------------------------------
-- Escolha do template
-- -----------------------------------------------------------------------------
create or replace function private.pick_template(p_service uuid, p_client_type public.client_type, p_area numeric)
returns table (template_id uuid, track_status public.track_status, note text)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ct public.client_type;
  v_has_area boolean;
  v_id uuid;
begin
  if not exists (select 1 from public.schedule_templates t where t.service_id = p_service and t.active) then
    return query select null::uuid, 'no_template'::public.track_status, 'Sem cronograma padrão'::text; return;
  end if;
  -- Variante específica do tipo de cliente tem prioridade sobre a geral.
  if exists (select 1 from public.schedule_templates t where t.service_id = p_service and t.active and t.client_type = p_client_type) then
    v_ct := p_client_type;
  elsif exists (select 1 from public.schedule_templates t where t.service_id = p_service and t.active and t.client_type is null) then
    v_ct := null;
  else
    return query select null::uuid, 'no_template'::public.track_status,
      format('Sem cronograma padrão para %s', upper(p_client_type::text)); return;
  end if;

  select bool_or(t.area_min is not null or t.area_max is not null) into v_has_area
  from public.schedule_templates t
  where t.service_id = p_service and t.active and t.client_type is not distinct from v_ct;

  if v_has_area then
    if p_area is null then
      return query select null::uuid, 'awaiting_area'::public.track_status, 'Área necessária para definir cronograma.'::text; return;
    end if;
    select t.id into v_id from public.schedule_templates t
    where t.service_id = p_service and t.active and t.client_type is not distinct from v_ct
      and (t.area_min is null or p_area > t.area_min) and (t.area_max is null or p_area <= t.area_max)
    order by t.version desc limit 1;
  else
    select t.id into v_id from public.schedule_templates t
    where t.service_id = p_service and t.active and t.client_type is not distinct from v_ct
    order by t.version desc limit 1;
  end if;

  if v_id is null then
    return query select null::uuid, 'no_template'::public.track_status, 'Nenhum cronograma padrão cobre esta área'::text; return;
  end if;
  return query select v_id, 'planned'::public.track_status, null::text;
end;
$$;

-- -----------------------------------------------------------------------------
-- Cálculo (sem gravar). p_overrides: {"<task_id>": {"start": "aaaa-mm-dd", "duration": n}}
-- Ordem topológica pela profundidade no grafo de dependências.
-- -----------------------------------------------------------------------------
create or replace function private.compute_schedule(p_project uuid, p_overrides jsonb default '{}'::jsonb)
returns table (task_id uuid, new_start date, new_end date, new_duration int)
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  cal uuid;
  base date;
  t record;
  dep record;
  m jsonb := '{}'::jsonb;
  ov jsonb;
  v_start date; v_end date; v_dur int; v_eff date; v_cand date; v_cross_end date;
  v_unknown boolean; v_unknown_end boolean; v_has_cross boolean; v_n int;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null then return; end if;
  cal  := private.calendar_for_tenant(p.delivery_tenant_id);
  base := public.next_business_day(coalesce(p.started_at::date, current_date), cal);

  for t in
    with recursive depth(id, d) as (
      select pt.id, 0 from public.project_tasks pt where pt.project_id = p_project
      union
      select dp.task_id, depth.d + 1
      from public.task_dependencies dp join depth on dp.depends_on_task_id = depth.id
      where depth.d < 500
    )
    select pt.*, tr.base_date as track_base, mx.d
    from public.project_tasks pt
    join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
    join (select id, max(d) as d from depth group by id) mx on mx.id = pt.id
    where pt.project_id = p_project
    order by mx.d, tr.created_at, pt.sequence
  loop
    ov    := coalesce(p_overrides -> t.id::text, '{}'::jsonb);
    v_dur := coalesce((ov ->> 'duration')::int, t.planned_duration_days);

    if t.status = 'cancelled' then
      -- Etapa cancelada/dispensada não ocupa tempo, mas mantém a corrente:
      -- repassa às seguintes o término dos seus predecessores.
      select count(*), bool_or((m -> d.depends_on_task_id::text ->> 'e') is null), max((m -> d.depends_on_task_id::text ->> 'e')::date)
        into v_n, v_unknown, v_cand
      from public.task_dependencies d
      where d.task_id = t.id and m ? d.depends_on_task_id::text;
      if v_n > 0 then
        m := m || jsonb_build_object(t.id::text, jsonb_build_object(
               's', case when v_unknown then null else v_cand end, 'e', case when v_unknown then null else v_cand end));
      end if;
      continue;
    end if;

    if t.status = 'completed' then
      m := m || jsonb_build_object(t.id::text, jsonb_build_object(
             's', coalesce(t.actual_start_date, t.planned_start_date),
             'e', coalesce(t.actual_end_date, t.planned_end_date)));
      task_id := t.id; new_start := t.planned_start_date; new_end := t.planned_end_date; new_duration := t.planned_duration_days;
      return next; continue;
    end if;

    if t.actual_start_date is not null then
      -- Etapa já iniciada: início previsto não muda; término segue a duração a partir do início real.
      v_start := t.planned_start_date;
      v_eff   := coalesce(t.actual_start_date, t.planned_start_date);
      if t.duration_type in ('fixed', 'external') and v_dur is not null then
        v_end := public.add_business_days(v_eff, v_dur, cal);
      else
        v_end := t.planned_end_date;
      end if;
      m := m || jsonb_build_object(t.id::text, jsonb_build_object('s', v_eff, 'e', v_end));
      task_id := t.id; new_start := v_start; new_end := v_end;
      new_duration := case when t.duration_type = 'dependent' then t.planned_duration_days else v_dur end;
      return next; continue;
    end if;

    -- Etapa não iniciada: início = maior entre a base da trilha, "não antes de" e as dependências.
    v_start := public.next_business_day(
                 greatest(coalesce(t.track_base, base), coalesce((ov ->> 'start')::date, t.start_not_before), base), cal);
    v_unknown := false; v_unknown_end := false; v_has_cross := false; v_cross_end := null; v_end := null;

    for dep in
      select d.dependency_type, d.lag_days, d.depends_on_task_id, pt2.schedule_track_id as pred_track
      from public.task_dependencies d
      join public.project_tasks pt2 on pt2.id = d.depends_on_task_id
      where d.task_id = t.id
    loop
      if not (m ? dep.depends_on_task_id::text) then continue; end if;

      -- "Dependente": a duração é o tempo até a etapa do outro serviço terminar.
      if t.duration_type = 'dependent' and dep.pred_track <> t.schedule_track_id then
        v_has_cross := true;
        v_cand := (m -> dep.depends_on_task_id::text ->> 'e')::date;
        if v_cand is null then v_unknown_end := true; else v_cross_end := greatest(v_cross_end, v_cand); end if;
        continue;
      end if;

      if dep.dependency_type = 'start_to_start' then
        v_cand := (m -> dep.depends_on_task_id::text ->> 's')::date;
      elsif dep.dependency_type = 'finish_to_finish' then
        continue;  -- restringe o término (abaixo)
      else
        v_cand := (m -> dep.depends_on_task_id::text ->> 'e')::date + 1;
      end if;

      if v_cand is null then
        v_unknown := true;
      else
        v_cand := public.next_business_day(v_cand, cal);
        if dep.lag_days > 0 then v_cand := public.add_business_days(v_cand, dep.lag_days + 1, cal); end if;
        v_start := greatest(v_start, v_cand);
      end if;
    end loop;

    if v_unknown then v_start := null; end if;

    if v_start is null then
      v_end := null;
    elsif t.duration_type = 'fixed' then
      v_end := case when v_dur is null then null else public.add_business_days(v_start, v_dur, cal) end;
    elsif t.duration_type = 'dependent' then
      if v_unknown_end then v_end := null;
      elsif v_has_cross then v_end := greatest(v_start, v_cross_end);
      else v_end := v_start;
      end if;
      v_dur := case when v_end is null then null else public.business_days_between(v_start, v_end, cal) end;
    elsif t.duration_type = 'external' then
      -- Prazo de terceiro: só tem término previsto se alguém informar uma estimativa.
      v_end := case when v_dur is null then null else public.add_business_days(v_start, v_dur, cal) end;
    else
      v_end := null;  -- contínua (ongoing)
    end if;

    -- Término-término: não terminar antes do predecessor.
    if v_end is not null then
      select greatest(v_end, max((m -> d.depends_on_task_id::text ->> 'e')::date)) into v_end
      from public.task_dependencies d
      where d.task_id = t.id and d.dependency_type = 'finish_to_finish' and m ? d.depends_on_task_id::text;
    end if;

    m := m || jsonb_build_object(t.id::text, jsonb_build_object('s', v_start, 'e', v_end));
    task_id := t.id; new_start := v_start; new_end := v_end; new_duration := v_dur;
    return next;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Aplica o cálculo, atualiza "pronta para iniciar" e o resumo das trilhas.
-- Retorna as etapas cujas datas mudaram.
-- -----------------------------------------------------------------------------
create or replace function private.apply_schedule(p_project uuid)
returns uuid[]
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_ids uuid[] := '{}';
begin
  perform private.engine_on();

  for r in
    select c.task_id, c.new_start, c.new_end, c.new_duration,
           pt.planned_start_date as os, pt.planned_end_date as oe, pt.planned_duration_days as od
    from private.compute_schedule(p_project) c
    join public.project_tasks pt on pt.id = c.task_id
  loop
    if (r.new_start, r.new_end, r.new_duration) is distinct from (r.os, r.oe, r.od) then
      update public.project_tasks
         set planned_start_date = r.new_start, planned_end_date = r.new_end, planned_duration_days = r.new_duration
       where id = r.task_id;
      if (r.new_start, r.new_end) is distinct from (r.os, r.oe) then v_ids := v_ids || r.task_id; end if;
    end if;
  end loop;

  -- Pronta para iniciar: predecessores concluídos (ou iniciados, no caso início-início).
  -- Etapas canceladas são atravessadas: valem os predecessores delas.
  with recursive eff(task_id, pred_id, dtype) as (
    select d.task_id, d.depends_on_task_id, d.dependency_type
    from public.task_dependencies d join public.project_tasks t on t.id = d.task_id
    where t.project_id = p_project
    union
    select e.task_id, d.depends_on_task_id, 'finish_to_start'::public.dependency_type
    from eff e
    join public.project_tasks c on c.id = e.pred_id and c.status = 'cancelled'
    join public.task_dependencies d on d.task_id = c.id
  ),
  blocked as (
    select distinct e.task_id from eff e
    join public.project_tasks p2 on p2.id = e.pred_id
    where p2.status <> 'cancelled'
      and ((e.dtype = 'start_to_start' and p2.actual_start_date is null)
        or (e.dtype <> 'start_to_start' and p2.status <> 'completed'))
  )
  update public.project_tasks t
     set status = case when t.id in (select task_id from blocked) then 'not_started'::public.task_status else 'ready'::public.task_status end
   where t.project_id = p_project and t.status in ('not_started', 'ready')
     and t.status <> case when t.id in (select task_id from blocked) then 'not_started'::public.task_status else 'ready'::public.task_status end;

  -- Resumo das trilhas
  update public.project_schedule_tracks tr set
    planned_start_date = x.ps, planned_end_date = x.pe, actual_start_date = x.as_, actual_end_date = x.ae,
    status = case
      when tr.status in ('no_template', 'awaiting_area', 'cancelled') then tr.status
      when x.total > 0 and x.done = x.total then 'completed'
      when x.as_ is not null then 'in_progress'
      else 'planned' end
  from (
    select pt.schedule_track_id as id,
           min(pt.planned_start_date) filter (where pt.status <> 'cancelled') as ps,
           case when bool_and(pt.planned_end_date is not null or pt.duration_type = 'ongoing') filter (where pt.status <> 'cancelled')
                then max(pt.planned_end_date) filter (where pt.status <> 'cancelled') end as pe,
           min(pt.actual_start_date) as as_,
           case when bool_and(pt.status in ('completed', 'cancelled')) then max(pt.actual_end_date) end as ae,
           count(*) filter (where pt.status <> 'cancelled') as total,
           count(*) filter (where pt.status = 'completed') as done
    from public.project_tasks pt where pt.project_id = p_project
    group by pt.schedule_track_id
  ) x
  where tr.id = x.id;

  return v_ids;
end;
$$;

-- -----------------------------------------------------------------------------
-- Dependências entre serviços (pelo template), etapas dependentes sem serviço
-- predecessor e reativação quando o serviço passa a existir.
-- -----------------------------------------------------------------------------
create or replace function private.link_cross_dependencies(p_project uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.engine_on();

  insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, lag_days, source)
  select distinct on (a.id, b.id) a.id, b.id, d.dependency_type, d.lag_days, 'template'
  from public.project_tasks a
  join public.template_task_dependencies d on d.template_task_id = a.template_task_id and d.predecessor_service_code is not null
  join public.services s on s.code = d.predecessor_service_code
  join public.project_services ps on ps.project_id = a.project_id and ps.service_id = s.id and ps.active
  join public.project_schedule_tracks tr on tr.project_service_id = ps.id
  join public.project_tasks b on b.schedule_track_id = tr.id and b.code = d.predecessor_task_code
  where a.project_id = p_project and a.status <> 'completed' and a.id <> b.id
  on conflict (task_id, depends_on_task_id) do nothing;

  -- "Tempo de produção da Arquitetura" sem Arquitetura contratada: etapa dispensada.
  update public.project_tasks t
     set status = 'cancelled', auto_skipped = true,
         waiting_reason = 'Dispensada: serviço predecessor não contratado'
   where t.project_id = p_project and t.duration_type = 'dependent' and t.actual_start_date is null
     and t.status in ('not_started', 'ready')
     and not exists (select 1 from public.task_dependencies d
                     join public.project_tasks p2 on p2.id = d.depends_on_task_id
                     where d.task_id = t.id and p2.schedule_track_id <> t.schedule_track_id);

  update public.project_tasks t
     set status = 'not_started', auto_skipped = false, waiting_reason = null
   where t.project_id = p_project and t.auto_skipped and t.status = 'cancelled'
     and exists (select 1 from public.task_dependencies d
                 join public.project_tasks p2 on p2.id = d.depends_on_task_id
                 where d.task_id = t.id and p2.schedule_track_id <> t.schedule_track_id);
end;
$$;

-- -----------------------------------------------------------------------------
-- Geração: cria trilhas para serviços ativos sem trilha e tenta de novo as
-- trilhas "sem template" / "aguardando área". Não toca no que já foi gerado.
-- -----------------------------------------------------------------------------
create or replace function private.generate_schedule(p_project uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  cal uuid;
  v_base date;
  v_codes text[];
  ps record;
  tr public.project_schedule_tracks;
  pick record;
  v_tracks int := 0;
  v_tasks int := 0;
  v_n int;
  v_pending int;
  v_ids uuid[];
begin
  select * into p from public.projects where id = p_project;
  if p.id is null then raise exception 'Projeto não encontrado' using errcode = 'P0002'; end if;
  perform private.engine_on();

  cal    := private.calendar_for_tenant(p.delivery_tenant_id);
  v_base := public.next_business_day(greatest(coalesce(p.started_at::date, current_date), current_date), cal);
  v_codes := array(select s.code from public.project_services x join public.services s on s.id = x.service_id
                   where x.project_id = p.id and x.active and x.status in ('active', 'completed'));

  for ps in
    select x.id, x.service_id from public.project_services x
    where x.project_id = p.id and x.active and x.status = 'active'
    order by x.created_at
  loop
    select * into tr from public.project_schedule_tracks where project_service_id = ps.id;
    if tr.id is not null and (tr.status not in ('no_template', 'awaiting_area')
                              or exists (select 1 from public.project_tasks where schedule_track_id = tr.id)) then
      continue;
    end if;

    select * into pick from private.pick_template(ps.service_id, p.client_type, p.area_m2);

    if tr.id is null then
      insert into public.project_schedule_tracks (project_id, project_service_id, template_id, status, base_date, status_note)
      values (p.id, ps.id, pick.template_id, pick.track_status, v_base, pick.note)
      returning * into tr;
      v_tracks := v_tracks + 1;
    else
      update public.project_schedule_tracks
         set template_id = pick.template_id, status = pick.track_status, status_note = pick.note, base_date = v_base
       where id = tr.id
      returning * into tr;
    end if;

    if pick.template_id is null then continue; end if;

    insert into public.project_tasks (schedule_track_id, project_id, template_task_id, code, name, description, sequence,
                                      duration_type, planned_duration_days, client_visible, status)
    select tr.id, p.id, tt.id, tt.code, tt.name, tt.description, tt.sort_order,
           tt.duration_type, tt.default_duration_days, tt.client_visible, 'not_started'
    from public.template_tasks tt
    where tt.template_id = pick.template_id and tt.active
      and (tt.include_if_service_codes is null or tt.include_if_service_codes && v_codes);
    get diagnostics v_n = row_count;
    v_tasks := v_tasks + v_n;

    -- Dependências internas; etapas condicionais excluídas são "atravessadas".
    insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, lag_days, source)
    with recursive inc as (
      select pt.template_task_id as id from public.project_tasks pt where pt.schedule_track_id = tr.id
    ),
    chain(task_tt, pred_tt, dtype, lag) as (
      select d.template_task_id, d.predecessor_task_id, d.dependency_type, d.lag_days
      from public.template_task_dependencies d
      where d.predecessor_task_id is not null and d.template_task_id in (select id from inc)
      union
      select c.task_tt, d.predecessor_task_id, 'finish_to_start'::public.dependency_type, 0
      from chain c
      join public.template_task_dependencies d on d.template_task_id = c.pred_tt
      where c.pred_tt not in (select id from inc) and d.predecessor_task_id is not null
    )
    select distinct on (a.id, b.id) a.id, b.id, c.dtype, c.lag, 'template'
    from chain c
    join public.project_tasks a on a.schedule_track_id = tr.id and a.template_task_id = c.task_tt
    join public.project_tasks b on b.schedule_track_id = tr.id and b.template_task_id = c.pred_tt
    on conflict (task_id, depends_on_task_id) do nothing;
  end loop;

  perform private.link_cross_dependencies(p.id);
  v_ids := private.apply_schedule(p.id);

  select count(*) into v_pending from public.project_schedule_tracks
  where project_id = p.id and status in ('no_template', 'awaiting_area');

  if v_tracks > 0 or v_tasks > 0 then
    insert into public.task_changes (project_id, change_type, after, reason, impacted_task_ids, changed_by)
    values (p.id, 'created', jsonb_build_object('tracks', v_tracks, 'tasks', v_tasks),
            coalesce(p_reason, 'Cronograma gerado'), v_ids, private.current_profile_id());
  end if;

  return jsonb_build_object('tracks_created', v_tracks, 'tasks_created', v_tasks, 'tracks_pending', v_pending);
end;
$$;

-- Projeto iniciado (equipe confirmada) → gera o cronograma.
create or replace function private.on_project_started()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'in_progress' and old.status = 'awaiting_team_assignment' then
    perform private.generate_schedule(new.id, 'Projeto iniciado: cronograma gerado a partir dos templates');
  end if;
  return null;
end;
$$;
create trigger projects_generate_schedule after update of status on public.projects
  for each row execute function private.on_project_started();

-- -----------------------------------------------------------------------------
-- Auxiliares de validação
-- -----------------------------------------------------------------------------
create or replace function private.task_for_edit(p_task uuid, p_manager_only boolean)
returns public.project_tasks
language plpgsql stable security definer set search_path = ''
as $$
declare t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task;
  if t.id is null or not private.can_view_project(t.project_id) or not private.is_staff() then
    raise exception 'Etapa não encontrada' using errcode = 'P0002';
  end if;
  if private.can_edit_schedule(t.project_id) then return t; end if;
  if not p_manager_only and t.responsible_user_id = private.current_profile_id() then return t; end if;
  raise exception 'Sem permissão para alterar esta etapa' using errcode = '42501';
end;
$$;

create or replace function private.task_snapshot(t public.project_tasks)
returns jsonb language sql immutable set search_path = ''
as $$
  select jsonb_build_object('status', t.status, 'planned_start_date', t.planned_start_date, 'planned_end_date', t.planned_end_date,
    'planned_duration_days', t.planned_duration_days, 'start_not_before', t.start_not_before,
    'actual_start_date', t.actual_start_date, 'actual_end_date', t.actual_end_date, 'responsible_user_id', t.responsible_user_id)
$$;

-- -----------------------------------------------------------------------------
-- Ações de cronograma (expostas por invólucros SECURITY INVOKER)
-- -----------------------------------------------------------------------------
create or replace function private.generate_project_schedule(p_project uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare p public.projects;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_edit_schedule(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão' using errcode = '42501';
  end if;
  if p.status not in ('in_progress', 'on_hold') then
    raise exception 'O cronograma é gerado quando a equipe é confirmada e o projeto inicia' using errcode = '23514';
  end if;
  return private.generate_schedule(p.id, 'Cronograma gerado novamente para serviços pendentes');
end;
$$;

create or replace function private.set_project_area(p_project uuid, p_area numeric)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare p public.projects;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_edit_schedule(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão' using errcode = '42501';
  end if;
  if p_area is null or p_area <= 0 or p_area > 1000000 then
    raise exception 'Informe a área em m² (maior que zero)' using errcode = '23514';
  end if;
  update public.projects set area_m2 = round(p_area, 2) where id = p.id;
  perform private.log_audit('project_area_set', 'projects', p.id, p.delivery_tenant_id,
    jsonb_build_object('before', p.area_m2, 'after', round(p_area, 2)));
  if p.status in ('in_progress', 'on_hold') then
    return private.generate_schedule(p.id, 'Área informada: cronograma definido');
  end if;
  return jsonb_build_object('tracks_created', 0, 'tasks_created', 0);
end;
$$;

-- Serviço adicional revisado pelo gestor → entra no cronograma sem reiniciar o restante.
create or replace function private.activate_project_service(p_project_service uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  ps public.project_services;
  p public.projects;
  v jsonb := '{}'::jsonb;
begin
  select * into ps from public.project_services where id = p_project_service;
  select * into p from public.projects where id = ps.project_id;
  if ps.id is null or not private.can_edit_schedule(p.id) then
    raise exception 'Serviço não encontrado ou sem permissão' using errcode = '42501';
  end if;
  if ps.status <> 'pending_review' or not ps.active then
    raise exception 'Este serviço já foi revisado' using errcode = '23514';
  end if;
  update public.project_services
     set status = 'active', activated_at = now(), added_by = coalesce(added_by, private.current_profile_id())
   where id = ps.id;
  perform private.log_audit('project_service_activated', 'project_services', ps.id, p.delivery_tenant_id,
    jsonb_build_object('project_id', p.id, 'service_id', ps.service_id));
  if p.status in ('in_progress', 'on_hold') then
    v := private.generate_schedule(p.id, 'Serviço adicional incluído no cronograma');
  end if;
  return v;
end;
$$;

-- Prévia: o que muda se a etapa começar em p_start e/ou durar p_duration dias úteis.
create or replace function private.preview_task_change(p_task uuid, p_start date default null, p_duration int default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  ov jsonb := '{}'::jsonb;
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

  with calc as (
    select c.*, pt.name, pt.planned_start_date as os, pt.planned_end_date as oe, s.name as service_name
    from private.compute_schedule(t.project_id, jsonb_build_object(t.id::text, ov)) c
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
            'before_start', c.os, 'before_end', c.oe, 'after_start', c.new_start, 'after_end', c.new_end)
            order by c.new_start nulls last, c.name)
     from calc c where c.task_id <> t.id and (c.new_start, c.new_end) is distinct from (c.os, c.oe)), '[]'::jsonb),
    (select max(c.oe) from calc c),
    (select max(c.new_end) from calc c)
  into v_task, v_items, v_forecast_before, v_forecast_after;

  return jsonb_build_object('task', v_task, 'impacted', v_items, 'impacted_count', jsonb_array_length(v_items),
                            'forecast_before', v_forecast_before, 'forecast_after', v_forecast_after);
end;
$$;

create or replace function private.reschedule_task(p_task uuid, p_start date, p_duration int, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  t2 public.project_tasks;
  v_ids uuid[];
begin
  t := private.task_for_edit(p_task, true);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Informe o motivo da alteração de prazo' using errcode = '23514';
  end if;
  if p_start is null and p_duration is null then
    raise exception 'Informe a nova data de início ou a nova duração' using errcode = '23514';
  end if;
  perform private.preview_task_change(p_task, p_start, p_duration);  -- mesmas validações

  perform private.engine_on();
  update public.project_tasks
     set start_not_before = coalesce(p_start, start_not_before),
         planned_duration_days = coalesce(p_duration, planned_duration_days)
   where id = t.id;
  v_ids := private.apply_schedule(t.project_id);
  select * into t2 from public.project_tasks where id = t.id;

  insert into public.task_changes (project_id, task_id, change_type, before, after, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, case when p_start is not null then 'reschedule' else 'duration' end,
          private.task_snapshot(t), private.task_snapshot(t2), trim(p_reason),
          array_remove(v_ids, t.id), private.current_profile_id());

  return jsonb_build_object('impacted_count', coalesce(array_length(array_remove(v_ids, t.id), 1), 0),
                            'planned_start_date', t2.planned_start_date, 'planned_end_date', t2.planned_end_date);
end;
$$;

-- Status da etapa. Responsável (colaborador) pode iniciar, concluir e sinalizar espera/impedimento.
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
      when p_status in ('in_progress', 'completed', 'waiting_client', 'waiting_third_party') then coalesce(actual_start_date, current_date)
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

create or replace function private.set_task_responsible(p_task uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  t2 public.project_tasks;
  p public.projects;
  u public.profiles;
begin
  t := private.task_for_edit(p_task, true);
  select * into p from public.projects where id = t.project_id;
  if p_user is not null then
    select * into u from public.profiles where id = p_user;
    if u.id is null or u.status <> 'ativo' or u.role not in ('collaborator', 'leader', 'unit_admin') then
      raise exception 'Responsável inválido ou inativo' using errcode = '23514';
    end if;
    if u.tenant_id is distinct from p.delivery_tenant_id then
      raise exception 'O responsável precisa pertencer à unidade executora do projeto' using errcode = '23514';
    end if;
  end if;
  if t.responsible_user_id is not distinct from p_user then return; end if;

  perform private.engine_on();
  update public.project_tasks set responsible_user_id = p_user where id = t.id returning * into t2;
  insert into public.task_changes (project_id, task_id, change_type, before, after, changed_by)
  values (t.project_id, t.id, 'responsible', jsonb_build_object('responsible_user_id', t.responsible_user_id),
          jsonb_build_object('responsible_user_id', p_user), private.current_profile_id());
  if p_user is not null then
    perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Nova etapa sob sua responsabilidade',
      t.name || ' · ' || p.name, 'project_tasks', t.id, '{}'::jsonb, null, p_user);
  end if;
end;
$$;

create or replace function private.add_task_dependency(p_task uuid, p_depends_on uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  v_ids uuid[];
begin
  t := private.task_for_edit(p_task, true);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Informe o motivo da nova dependência' using errcode = '23514';
  end if;
  if not exists (select 1 from public.project_tasks where id = p_depends_on and project_id = t.project_id) then
    raise exception 'Escolha uma etapa deste projeto' using errcode = '23514';
  end if;
  perform private.engine_on();
  insert into public.task_dependencies (task_id, depends_on_task_id, source, created_by)
  values (t.id, p_depends_on, 'manual', private.current_profile_id());
  v_ids := private.apply_schedule(t.project_id);
  insert into public.task_changes (project_id, task_id, change_type, after, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, 'dependency', jsonb_build_object('added', p_depends_on), trim(p_reason), v_ids, private.current_profile_id());
  return jsonb_build_object('impacted_count', coalesce(array_length(v_ids, 1), 0));
exception when unique_violation then
  raise exception 'Esta dependência já existe' using errcode = '23505';
end;
$$;


-- =============================================================================
-- Gerenciador de templates (ADM Global)
-- =============================================================================
create or replace function private.slug(p text) returns text
language sql immutable set search_path = ''
as $$
  select trim(both '_' from regexp_replace(
           translate(lower(coalesce(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'),
           '[^a-z0-9]+', '_', 'g'))
$$;

create or replace function private.create_template_draft(
  p_service uuid, p_from uuid default null, p_client_type public.client_type default null,
  p_area_min numeric default null, p_area_max numeric default null, p_name text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  src public.schedule_templates;
  s public.services;
  v_id uuid := gen_random_uuid();
  v_ct public.client_type := p_client_type;
  v_min numeric := p_area_min;
  v_max numeric := p_area_max;
  v_version int;
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  if p_from is not null then
    select * into src from public.schedule_templates where id = p_from;
    if src.id is null then raise exception 'Template não encontrado' using errcode = 'P0002'; end if;
    p_service := src.service_id; v_ct := src.client_type; v_min := src.area_min; v_max := src.area_max;
  end if;
  select * into s from public.services where id = p_service;
  if s.id is null then raise exception 'Serviço não encontrado' using errcode = 'P0002'; end if;
  if v_min is not null and v_max is not null and v_min >= v_max then
    raise exception 'A área mínima deve ser menor que a máxima' using errcode = '23514';
  end if;
  if exists (select 1 from public.schedule_templates t
             where t.service_id = p_service and t.status = 'draft' and t.client_type is not distinct from v_ct
               and t.area_min is not distinct from v_min and t.area_max is not distinct from v_max) then
    raise exception 'Já existe um rascunho desta variante. Continue editando ou descarte-o.' using errcode = '23505';
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.schedule_templates t
  where t.service_id = p_service and t.client_type is not distinct from v_ct
    and t.area_min is not distinct from v_min and t.area_max is not distinct from v_max;

  insert into public.schedule_templates (id, service_id, name, version, client_type, area_min, area_max, status, active, created_by)
  values (v_id, p_service, coalesce(nullif(trim(p_name), ''), src.name, s.name), v_version, v_ct, v_min, v_max,
          'draft', false, private.current_profile_id());

  if src.id is not null then
    insert into public.template_tasks (template_id, code, name, description, sort_order, default_duration_days, duration_type,
                                       include_if_service_codes, client_visible, active)
    select v_id, code, name, description, sort_order, default_duration_days, duration_type, include_if_service_codes, client_visible, active
    from public.template_tasks where template_id = src.id;

    insert into public.template_task_dependencies (template_task_id, predecessor_task_id, predecessor_service_code,
                                                   predecessor_task_code, dependency_type, lag_days, optional_if_missing)
    select nt.id, np.id, d.predecessor_service_code, d.predecessor_task_code, d.dependency_type, d.lag_days, d.optional_if_missing
    from public.template_task_dependencies d
    join public.template_tasks ot on ot.id = d.template_task_id and ot.template_id = src.id
    join public.template_tasks nt on nt.template_id = v_id and nt.code = ot.code
    left join public.template_tasks op on op.id = d.predecessor_task_id
    left join public.template_tasks np on np.template_id = v_id and np.code = op.code
    where d.predecessor_task_id is null or np.id is not null;
  end if;

  return v_id;
end;
$$;


create or replace function private.publish_template(p_template uuid, p_notes text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare tpl public.schedule_templates;
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  select * into tpl from public.schedule_templates where id = p_template for update;
  if tpl.id is null then raise exception 'Template não encontrado' using errcode = 'P0002'; end if;
  if tpl.status <> 'draft' then raise exception 'Esta versão já foi publicada' using errcode = '23514'; end if;
  if not exists (select 1 from public.template_tasks where template_id = tpl.id and active) then
    raise exception 'O template precisa de ao menos uma etapa' using errcode = '23514';
  end if;
  -- Faixas de área de variantes vigentes não podem se sobrepor (mesmo serviço e tipo de cliente).
  if exists (
    select 1 from public.schedule_templates o
    where o.service_id = tpl.service_id and o.active and o.client_type is not distinct from tpl.client_type
      and not (o.area_min is not distinct from tpl.area_min and o.area_max is not distinct from tpl.area_max)
      and coalesce(o.area_min, -1) < coalesce(tpl.area_max, 1e12) and coalesce(tpl.area_min, -1) < coalesce(o.area_max, 1e12)
  ) then
    raise exception 'A faixa de área desta variante se sobrepõe a outra variante vigente do serviço' using errcode = '23514';
  end if;

  update public.schedule_templates set active = false, status = 'archived'
   where service_id = tpl.service_id and active and client_type is not distinct from tpl.client_type
     and area_min is not distinct from tpl.area_min and area_max is not distinct from tpl.area_max;
  update public.schedule_templates
     set status = 'published', active = true, published_by = private.current_profile_id(), published_at = now(),
         notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes)
   where id = tpl.id;
end;
$$;



-- =============================================================================
-- API pública: invólucros SECURITY INVOKER
-- =============================================================================
create or replace function public.generate_project_schedule(p_project uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.generate_project_schedule(p_project) $$;
create or replace function public.set_project_area(p_project uuid, p_area numeric) returns jsonb
language sql security invoker set search_path = '' as $$ select private.set_project_area(p_project, p_area) $$;
create or replace function public.activate_project_service(p_project_service uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.activate_project_service(p_project_service) $$;
create or replace function public.preview_task_change(p_task uuid, p_start date default null, p_duration int default null) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.preview_task_change(p_task, p_start, p_duration) $$;
create or replace function public.reschedule_task(p_task uuid, p_start date, p_duration int, p_reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.reschedule_task(p_task, p_start, p_duration, p_reason) $$;
create or replace function public.set_task_status(p_task uuid, p_status public.task_status, p_reason text default null) returns jsonb
language sql security invoker set search_path = '' as $$ select private.set_task_status(p_task, p_status, p_reason) $$;
create or replace function public.set_task_responsible(p_task uuid, p_user uuid) returns void
language sql security invoker set search_path = '' as $$ select private.set_task_responsible(p_task, p_user) $$;
create or replace function public.add_task_dependency(p_task uuid, p_depends_on uuid, p_reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.add_task_dependency(p_task, p_depends_on, p_reason) $$;
create or replace function public.create_template_draft(p_service uuid, p_from uuid default null, p_client_type public.client_type default null,
  p_area_min numeric default null, p_area_max numeric default null, p_name text default null) returns uuid
language sql security invoker set search_path = '' as $$ select private.create_template_draft(p_service, p_from, p_client_type, p_area_min, p_area_max, p_name) $$;
create or replace function public.publish_template(p_template uuid, p_notes text default null) returns void
language sql security invoker set search_path = '' as $$ select private.publish_template(p_template, p_notes) $$;

-- =============================================================================
-- Privilégios
-- =============================================================================
revoke all on function
  public.generate_project_schedule(uuid), public.set_project_area(uuid, numeric), public.activate_project_service(uuid),
  public.preview_task_change(uuid, date, int), public.reschedule_task(uuid, date, int, text),
  public.set_task_status(uuid, public.task_status, text), public.set_task_responsible(uuid, uuid),
  public.add_task_dependency(uuid, uuid, text),
  public.create_template_draft(uuid, uuid, public.client_type, numeric, numeric, text),
  public.publish_template(uuid, text)
from public, anon;
grant execute on function
  public.generate_project_schedule(uuid), public.set_project_area(uuid, numeric), public.activate_project_service(uuid),
  public.preview_task_change(uuid, date, int), public.reschedule_task(uuid, date, int, text),
  public.set_task_status(uuid, public.task_status, text), public.set_task_responsible(uuid, uuid),
  public.add_task_dependency(uuid, uuid, text),
  public.create_template_draft(uuid, uuid, public.client_type, numeric, numeric, text),
  public.publish_template(uuid, text)
to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
-- Peças internas do motor: só executam dentro das ações acima.
revoke execute on function private.engine_on(), private.compute_schedule(uuid, jsonb), private.apply_schedule(uuid),
                           private.link_cross_dependencies(uuid), private.generate_schedule(uuid, text),
                           private.on_project_started(), private.pick_template(uuid, public.client_type, numeric)
  from authenticated;
-- (mantém as revogações das etapas anteriores)
revoke execute on function private.process_intake(uuid), private.store_intake(text, text, jsonb),
                           private.notify(uuid, text, text, text, text, uuid, jsonb, public.user_role[], uuid),
                           private.resolve_notifications(text, uuid), private.link_profile_on_auth_user()
  from authenticated;
