-- =============================================================================
-- 0047 · Rodadas de revisão no cronograma (e ligação automática com Entregas)
--
--   No padrão (template), uma etapa pode ser marcada como "Apresentação ao
--   cliente". Ao gerar o cronograma, ela ganha, logo depois:
--     Feedback do cliente → Revisão 1 → Feedback do cliente · Revisão 1 → … → Revisão N → Feedback
--   N = revisões incluídas do serviço (Configurações › Entregas e revisões);
--   prazo de cada revisão e de cada feedback definidos no padrão (o feedback usa
--   o prazo de retorno da unidade quando não informado). As etapas seguintes do
--   padrão (e as de outros serviços que aguardavam a apresentação) passam a
--   aguardar o último feedback.
--
--   Entregas movem o cronograma sozinhas:
--     publicar apresentação  → conclui a apresentação e inicia o feedback (aguardando cliente);
--     cliente pede revisão N → conclui o feedback e inicia a Revisão N (cria a rodada se for adicional);
--     publicar revisão N     → conclui a Revisão N e inicia o feedback seguinte;
--     cliente aprova         → conclui o feedback e dispensa as rodadas não usadas (o projeto antecipa).
-- =============================================================================

alter table public.template_tasks
  add column review_cycle  boolean not null default false,
  add column review_days   int check (review_days is null or review_days between 1 and 60),
  add column feedback_days int check (feedback_days is null or feedback_days between 1 and 15);

alter table public.project_tasks
  add column cycle_parent_id uuid references public.project_tasks (id),
  add column cycle_kind      text check (cycle_kind in ('feedback', 'revision')),
  add column cycle_round     int check (cycle_round is null or cycle_round >= 0);
create index project_tasks_cycle_idx on public.project_tasks (cycle_parent_id, cycle_kind, cycle_round) where cycle_parent_id is not null;

-- Trilhas já geradas não ganham rodadas retroativamente.
alter table public.project_schedule_tracks add column cycles_done boolean not null default false;
update public.project_schedule_tracks tr set cycles_done = true
 where exists (select 1 from public.project_tasks t where t.schedule_track_id = tr.id);

-- -----------------------------------------------------------------------------
-- Padrões: salvar e copiar os campos novos
-- -----------------------------------------------------------------------------
create or replace function private.save_template_draft(p_template uuid, p_name text, p_tasks jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  tpl public.schedule_templates;
  x jsonb;
  i int := 0;
  v_id uuid;
  v_code text;
  v_type public.duration_type;
  v_days int;
  v_keep uuid[];
  v_prev_group uuid[] := '{}';
  v_group uuid[] := '{}';
  v_pred uuid;
  dep jsonb;
  v_cycle boolean;
  v_rev int;
  v_fb int;
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  select * into tpl from public.schedule_templates where id = p_template for update;
  if tpl.id is null then raise exception 'Template não encontrado' using errcode = 'P0002'; end if;
  if tpl.status <> 'draft' then
    raise exception 'Template publicado é imutável. Crie uma nova versão para alterar o padrão YouCon.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_tasks) <> 'array' or jsonb_array_length(p_tasks) = 0 then
    raise exception 'O template precisa de ao menos uma etapa' using errcode = '23514';
  end if;

  v_keep := array(select (e ->> 'id')::uuid from jsonb_array_elements(p_tasks) e where nullif(e ->> 'id', '') is not null);

  update public.template_task_dependencies d set active = false
    from public.template_tasks tt
   where tt.id = d.template_task_id and tt.template_id = tpl.id and d.active;
  update public.template_tasks set active = false
   where template_id = tpl.id and active and not (id = any (v_keep));

  update public.schedule_templates set name = coalesce(nullif(trim(p_name), ''), name) where id = tpl.id;

  for x in select * from jsonb_array_elements(p_tasks) loop
    i := i + 1;
    if length(trim(coalesce(x ->> 'name', ''))) = 0 then
      raise exception 'A etapa % está sem nome', i using errcode = '23514';
    end if;
    v_type := coalesce(nullif(x ->> 'duration_type', ''), 'fixed')::public.duration_type;
    v_days := nullif(x ->> 'duration_days', '')::int;
    if v_type <> 'fixed' then v_days := null; end if;
    if v_days is not null and (v_days < 1 or v_days > 2000) then
      raise exception 'Duração da etapa "%" deve ser de 1 a 2000 dias úteis', x ->> 'name' using errcode = '23514';
    end if;
    v_cycle := coalesce((x ->> 'review_cycle')::boolean, false);
    v_rev := case when v_cycle then nullif(x ->> 'review_days', '')::int end;
    v_fb := case when v_cycle then nullif(x ->> 'feedback_days', '')::int end;
    if v_cycle and (v_rev is null or v_rev < 1 or v_rev > 60) then
      raise exception 'Informe o prazo de cada revisão (1 a 60 dias úteis) em "%"', x ->> 'name' using errcode = '23514';
    end if;
    if v_fb is not null and (v_fb < 1 or v_fb > 15) then
      raise exception 'O prazo do feedback do cliente deve ser de 1 a 15 dias úteis' using errcode = '23514';
    end if;

    if i > 1 and not coalesce((x ->> 'parallel')::boolean, false) then
      v_prev_group := v_group;
      v_group := '{}';
    end if;

    v_id := nullif(x ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from public.template_tasks where id = v_id and template_id = tpl.id) then
      update public.template_tasks set
        name = trim(x ->> 'name'), description = nullif(trim(coalesce(x ->> 'description', '')), ''),
        sort_order = i * 10, default_duration_days = v_days, duration_type = v_type,
        include_if_service_codes = case when jsonb_typeof(x -> 'include_if') = 'array' and jsonb_array_length(x -> 'include_if') > 0
                                        then array(select jsonb_array_elements_text(x -> 'include_if')) end,
        client_visible = coalesce((x ->> 'client_visible')::boolean, true), active = true,
        review_cycle = v_cycle, review_days = v_rev, feedback_days = v_fb
      where id = v_id;
    else
      v_code := coalesce(nullif(private.slug(x ->> 'name'), ''), 'etapa');
      while exists (select 1 from public.template_tasks where template_id = tpl.id and code = v_code) loop
        v_code := v_code || '_' || i;
      end loop;
      insert into public.template_tasks (template_id, code, name, description, sort_order, default_duration_days, duration_type,
                                         include_if_service_codes, client_visible, review_cycle, review_days, feedback_days)
      values (tpl.id, v_code, trim(x ->> 'name'), nullif(trim(coalesce(x ->> 'description', '')), ''), i * 10, v_days, v_type,
              case when jsonb_typeof(x -> 'include_if') = 'array' and jsonb_array_length(x -> 'include_if') > 0
                   then array(select jsonb_array_elements_text(x -> 'include_if')) end,
              coalesce((x ->> 'client_visible')::boolean, true), v_cycle, v_rev, v_fb)
      returning id into v_id;
    end if;

    foreach v_pred in array v_prev_group loop
      insert into public.template_task_dependencies (template_task_id, predecessor_task_id) values (v_id, v_pred);
    end loop;
    v_group := v_group || v_id;

    for dep in select * from jsonb_array_elements(coalesce(x -> 'cross_deps', '[]'::jsonb)) loop
      if not exists (select 1 from public.services where code = dep ->> 'service_code') then
        raise exception 'Serviço da dependência não existe: %', dep ->> 'service_code' using errcode = '23514';
      end if;
      if (select code from public.services where id = tpl.service_id) = dep ->> 'service_code' then
        raise exception 'Use a sequência para dependências dentro do mesmo serviço' using errcode = '23514';
      end if;
      insert into public.template_task_dependencies (template_task_id, predecessor_service_code, predecessor_task_code, optional_if_missing)
      values (v_id, dep ->> 'service_code', dep ->> 'task_code', true);
    end loop;
    if v_type = 'dependent' and jsonb_array_length(coalesce(x -> 'cross_deps', '[]'::jsonb)) = 0 then
      raise exception 'A etapa "%" é do tipo dependente: indique de qual etapa de outro serviço ela depende', x ->> 'name'
        using errcode = '23514';
    end if;
  end loop;
end;
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
                                       include_if_service_codes, client_visible, active, review_cycle, review_days, feedback_days)
    select v_id, code, name, description, sort_order, default_duration_days, duration_type, include_if_service_codes, client_visible, active,
           review_cycle, review_days, feedback_days
    from public.template_tasks where template_id = src.id and active;

    insert into public.template_task_dependencies (template_task_id, predecessor_task_id, predecessor_service_code,
                                                   predecessor_task_code, dependency_type, lag_days, optional_if_missing)
    select nt.id, np.id, d.predecessor_service_code, d.predecessor_task_code, d.dependency_type, d.lag_days, d.optional_if_missing
    from public.template_task_dependencies d
    join public.template_tasks ot on ot.id = d.template_task_id and ot.template_id = src.id
    join public.template_tasks nt on nt.template_id = v_id and nt.code = ot.code
    left join public.template_tasks op on op.id = d.predecessor_task_id
    left join public.template_tasks np on np.template_id = v_id and np.code = op.code
    where d.active and (d.predecessor_task_id is null or np.id is not null);
  end if;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Rodadas no cronograma do projeto
-- -----------------------------------------------------------------------------
create or replace function private.cycle_member(p_parent uuid, p_kind text, p_round int) returns public.project_tasks
language sql stable security definer set search_path = ''
as $$ select * from public.project_tasks where cycle_parent_id = p_parent and cycle_kind = p_kind and cycle_round = p_round limit 1 $$;

-- Último elemento da corrente de uma apresentação (ou a própria etapa, se não tiver rodadas).
create or replace function private.cycle_end(p_task uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce((select c.id from public.project_tasks c where c.cycle_parent_id = p_task
                   order by c.cycle_round desc, (c.cycle_kind = 'feedback') desc limit 1), p_task)
$$;

create or replace function private.cycle_durations(p_parent uuid, out review_days int, out feedback_days int)
language sql stable security definer set search_path = ''
as $$
  select coalesce(tt.review_days, 5),
         coalesce(tt.feedback_days, (select r.days from private.client_wait_rules(p.delivery_tenant_id) r), 2)
  from public.project_tasks t
  join public.projects p on p.id = t.project_id
  left join public.template_tasks tt on tt.id = t.template_task_id
  where t.id = p_parent
$$;

-- Insere uma etapa da corrente logo depois de p_after (as seguintes passam a aguardá-la).
create or replace function private.cycle_insert(p_parent public.project_tasks, p_after uuid, p_kind text, p_round int) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d record;
  v_id uuid;
  v_name text;
  v_days int;
  v_members uuid[];
begin
  select * into d from private.cycle_durations(p_parent.id);
  v_name := case when p_kind = 'revision' then 'Revisão ' || p_round
                 when p_round = 0 then 'Feedback do cliente · ' || p_parent.name
                 else 'Feedback do cliente · Revisão ' || p_round end;
  v_days := case when p_kind = 'revision' then d.review_days else d.feedback_days end;
  insert into public.project_tasks (schedule_track_id, project_id, code, name, description, sequence, duration_type, planned_duration_days,
                                    client_visible, status, responsible_user_id, cycle_parent_id, cycle_kind, cycle_round)
  values (p_parent.schedule_track_id, p_parent.project_id,
          left(coalesce(p_parent.code, 'etapa'), 60) || case when p_kind = 'revision' then '__rev' else '__fb' end || p_round,
          v_name,
          case when p_kind = 'revision' then 'Rodada de revisão pedida pelo cliente.' else 'Prazo para o cliente aprovar ou pedir alterações.' end,
          p_parent.sequence + case when p_kind = 'revision' then 2 * p_round else 2 * p_round + 1 end,
          'fixed', v_days, true, 'not_started', p_parent.responsible_user_id,
          p_parent.id, p_kind, p_round)
  returning id into v_id;

  v_members := array(select c.id from public.project_tasks c where c.cycle_parent_id = p_parent.id) || p_parent.id;
  -- Quem aguardava p_after (fora da corrente) passa a aguardar a nova etapa.
  update public.task_dependencies set depends_on_task_id = v_id
   where depends_on_task_id = p_after and not (task_id = any (v_members));
  insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, lag_days, source)
  values (v_id, p_after, 'finish_to_start', 0, 'template')
  on conflict (task_id, depends_on_task_id) do nothing;
  return v_id;
end;
$$;

-- Garante a Revisão N e o seu feedback (rodada adicional cria na hora).
create or replace function private.cycle_ensure_round(p_parent uuid, p_round int) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  prev public.project_tasks;
  v_rev uuid;
begin
  select * into t from public.project_tasks where id = p_parent;
  if (private.cycle_member(p_parent, 'revision', p_round)).id is not null then return; end if;
  if p_round > 1 then perform private.cycle_ensure_round(p_parent, p_round - 1); end if;
  prev := private.cycle_member(p_parent, 'feedback', p_round - 1);
  if prev.id is null then return; end if;
  v_rev := private.cycle_insert(t, prev.id, 'revision', p_round);
  perform private.cycle_insert(t, v_rev, 'feedback', p_round);
end;
$$;

-- Expande as apresentações marcadas no padrão (uma vez por trilha).
create or replace function private.expand_review_cycles(p_project uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  tr record;
  t public.project_tasks;
  r record;
  v_n int := 0;
  i int;
begin
  perform private.engine_on();
  for tr in select x.* from public.project_schedule_tracks x
            where x.project_id = p_project and not x.cycles_done
              and exists (select 1 from public.project_tasks pt where pt.schedule_track_id = x.id) loop
    -- Espaço na numeração para as rodadas entre as etapas do padrão.
    update public.project_tasks set sequence = sequence * 100 where schedule_track_id = tr.id and cycle_kind is null;
    for t in select pt.* from public.project_tasks pt join public.template_tasks tt on tt.id = pt.template_task_id
             where pt.schedule_track_id = tr.id and tt.review_cycle and pt.status <> 'cancelled' and pt.cycle_kind is null
             order by pt.sequence loop
      select rr.* into r from public.project_services ps cross join lateral private.delivery_rules(ps.service_id) rr
       where ps.id = tr.project_service_id;
      perform private.cycle_insert(t, t.id, 'feedback', 0);
      for i in 1 .. (case when coalesce(r.revisions_enabled, true) then coalesce(r.included_revisions, 3) else 0 end) loop
        perform private.cycle_ensure_round(t.id, i);
      end loop;
      v_n := v_n + 1;
    end loop;
    update public.project_schedule_tracks set cycles_done = true where id = tr.id;
  end loop;
  return v_n;
end;
$$;

-- Vínculos entre serviços: quem aguardava uma apresentação passa a aguardar o fim das rodadas.
create or replace function private.link_cross_dependencies(p_project uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.engine_on();
  perform private.expand_review_cycles(p_project);

  insert into public.task_dependencies (task_id, depends_on_task_id, dependency_type, lag_days, source)
  select distinct on (a.id, private.cycle_end(b.id)) a.id, private.cycle_end(b.id), d.dependency_type, d.lag_days, 'template'
  from public.project_tasks a
  join public.template_task_dependencies d on d.template_task_id = a.template_task_id and d.active and d.predecessor_service_code is not null
  join public.services s on s.code = d.predecessor_service_code
  join public.project_services ps on ps.project_id = a.project_id and ps.service_id = s.id and ps.active
  join public.project_schedule_tracks tr on tr.project_service_id = ps.id
  join public.project_tasks b on b.schedule_track_id = tr.id and b.code = d.predecessor_task_code
  where a.project_id = p_project and a.status <> 'completed' and a.id <> b.id
    and not exists (select 1 from public.task_dependencies x where x.task_id = a.id and x.depends_on_task_id = b.id)
  on conflict (task_id, depends_on_task_id) do nothing;

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

-- Responsável da apresentação vale para as rodadas ainda não iniciadas (na revisão, faz;
-- no feedback, acompanha o retorno do cliente).
create or replace function private.cycle_follow_responsible() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.cycle_kind is null and new.responsible_user_id is distinct from old.responsible_user_id
     and exists (select 1 from public.project_tasks c where c.cycle_parent_id = new.id) then
    perform private.engine_on();
    update public.project_tasks c set responsible_user_id = new.responsible_user_id
     where c.cycle_parent_id = new.id and c.actual_start_date is null
       and c.status in ('not_started', 'ready')
       and (c.responsible_user_id is null or c.responsible_user_id = old.responsible_user_id);
  end if;
  return new;
end;
$$;
create trigger project_tasks_cycle_responsible after update of responsible_user_id on public.project_tasks
  for each row execute function private.cycle_follow_responsible();

-- -----------------------------------------------------------------------------
-- Entregas → cronograma
-- -----------------------------------------------------------------------------
-- Status interno (sem checagem de permissão: quem chama já validou a ação).
create or replace function private.cycle_set_status(p_task uuid, p_status public.task_status, p_reason text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  t2 public.project_tasks;
  v_today date := private.today_br();
begin
  select * into t from public.project_tasks where id = p_task;
  if t.id is null or t.status = p_status then return; end if;
  perform private.engine_on();
  update public.project_tasks set
    status = p_status,
    actual_start_date = case
      when p_status in ('in_progress', 'completed', 'waiting_client') then least(coalesce(actual_start_date, v_today), v_today)
      when p_status in ('not_started', 'ready') then null
      else actual_start_date end,
    actual_end_date = case when p_status = 'completed' then v_today else null end,
    waiting_reason = case when p_status in ('waiting_client', 'cancelled') then p_reason else null end,
    auto_skipped = false
  where id = t.id;
  select * into t2 from public.project_tasks where id = t.id;
  insert into public.task_changes (project_id, task_id, change_type, before, after, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, 'status', private.task_snapshot(t), private.task_snapshot(t2), p_reason, '{}', private.current_profile_id());
end;
$$;

-- Apresentação (com rodadas) do serviço da entrega.
create or replace function private.delivery_cycle_task(p_delivery uuid) returns public.project_tasks
language sql stable security definer set search_path = ''
as $$
  select t.* from public.project_tasks t
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  join public.project_deliveries d on d.project_service_id = tr.project_service_id
  where d.id = p_delivery and t.cycle_kind is null
    and exists (select 1 from public.project_tasks c where c.cycle_parent_id = t.id)
  order by t.sequence limit 1
$$;

create or replace function private.cycle_on_publish(v public.delivery_versions) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  m public.project_tasks;
begin
  t := private.delivery_cycle_task(v.delivery_id);
  if t.id is null or v.kind not in ('presentation', 'revision') then return false; end if;
  if v.kind = 'revision' then perform private.cycle_ensure_round(t.id, v.round); end if;
  if t.status not in ('completed', 'cancelled') then perform private.cycle_set_status(t.id, 'completed', 'Apresentação publicada em Entregas'); end if;
  if v.kind = 'revision' then
    m := private.cycle_member(t.id, 'feedback', v.round - 1);
    if m.status not in ('completed', 'cancelled') then perform private.cycle_set_status(m.id, 'completed', 'Cliente pediu a revisão ' || v.round); end if;
    m := private.cycle_member(t.id, 'revision', v.round);
    perform private.cycle_set_status(m.id, 'completed', 'Revisão ' || v.round || ' publicada em Entregas');
  end if;
  m := private.cycle_member(t.id, 'feedback', coalesce(v.round, 0));
  perform private.cycle_set_status(m.id, 'waiting_client', 'Aguardando a avaliação do cliente em Entregas');
  perform private.apply_schedule(t.project_id);
  return true;
end;
$$;

-- Publicação: com rodadas no cronograma, a espera do cliente é a etapa de feedback;
-- sem rodadas, segue a espera da própria entrega.
create or replace function private.client_wait_on_version() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare d public.project_deliveries;
begin
  if new.published_at is not null and old.published_at is null and new.kind in ('presentation', 'revision') then
    if private.cycle_on_publish(new) then return new; end if;
    select * into d from public.project_deliveries where id = new.delivery_id;
    if d.revisions_enabled then
      perform private.client_wait_open(new.project_id, 'delivery', d.id, new.id, null,
        'Avaliação: ' || new.title || ' · ' || private.delivery_service_name(d));
    end if;
  end if;
  return new;
end;
$$;

-- Pedido de revisão: fecha o feedback e inicia a Revisão N.
create or replace function private.cycle_on_request() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  m public.project_tasks;
begin
  t := private.delivery_cycle_task(new.delivery_id);
  if t.id is null then return new; end if;
  perform private.cycle_ensure_round(t.id, new.round);
  m := private.cycle_member(t.id, 'feedback', new.round - 1);
  if m.id is not null and m.status not in ('completed', 'cancelled') then
    perform private.cycle_set_status(m.id, 'completed', 'Cliente pediu a revisão ' || new.round);
  end if;
  m := private.cycle_member(t.id, 'revision', new.round);
  if m.responsible_user_id is null then
    perform private.engine_on();
    update public.project_tasks set responsible_user_id = coalesce(t.responsible_user_id, new.responsible_id) where id = m.id;
  end if;
  perform private.cycle_set_status(m.id, 'in_progress', null);
  m := private.cycle_member(t.id, 'feedback', new.round);
  if m.status = 'cancelled' then perform private.cycle_set_status(m.id, 'not_started', null); end if;
  perform private.apply_schedule(t.project_id);
  return new;
end;
$$;
create trigger delivery_revision_requests_cycle after insert on public.delivery_revision_requests
  for each row execute function private.cycle_on_request();

-- Aprovação: conclui o feedback em aberto e dispensa as rodadas não usadas.
create or replace function private.cycle_on_approval() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  m record;
begin
  if not (new.creation_approved_at is not null and old.creation_approved_at is null) then return new; end if;
  t := private.delivery_cycle_task(new.id);
  if t.id is null then return new; end if;
  for m in select * from public.project_tasks where cycle_parent_id = t.id and status not in ('completed', 'cancelled')
           order by cycle_round, (cycle_kind = 'feedback') loop
    if m.cycle_kind = 'feedback' and m.status = 'waiting_client' then
      perform private.cycle_set_status(m.id, 'completed', 'Cliente aprovou a fase de criação');
    else
      perform private.cycle_set_status(m.id, 'cancelled', 'Dispensada: cliente aprovou antes desta rodada');
    end if;
  end loop;
  perform private.apply_schedule(t.project_id);
  return new;
end;
$$;
create trigger project_deliveries_cycle after update of creation_approved_at on public.project_deliveries
  for each row execute function private.cycle_on_approval();

revoke all on function private.cycle_member(uuid, text, int), private.cycle_end(uuid), private.cycle_durations(uuid),
  private.cycle_insert(public.project_tasks, uuid, text, int), private.cycle_ensure_round(uuid, int), private.expand_review_cycles(uuid),
  private.cycle_set_status(uuid, public.task_status, text), private.delivery_cycle_task(uuid), private.cycle_on_publish(public.delivery_versions)
from public, anon;
grant execute on function private.cycle_member(uuid, text, int), private.cycle_end(uuid), private.cycle_durations(uuid),
  private.delivery_cycle_task(uuid)
to authenticated;
revoke execute on function private.link_cross_dependencies(uuid) from authenticated;
