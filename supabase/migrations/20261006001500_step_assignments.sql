-- =============================================================================
-- Portal de Projetos YouCon — Migration 0015 (Etapa 3): colaboradores indiretos
-- por sub-etapa.
--
-- Na definição da equipe, cada colaborador indireto recebe as sub-etapas pelas
-- quais responde (ex.: Imagens 3D e Vídeo do Arquitetônico). A escolha fica
-- registrada por serviço + código da etapa, então vale:
--   * para etapas já geradas (o responsável é trocado na hora);
--   * para etapas ainda não geradas (projeto aguardando início ou área):
--     um gatilho aplica o responsável quando a etapa nasce.
-- Sem DELETE: vínculos removidos ficam inativos (histórico preservado).
-- =============================================================================

create table public.project_step_assignments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  project_service_id uuid not null references public.project_services (id) on delete cascade,
  task_code text not null,
  user_id uuid not null references public.profiles (id),
  active boolean not null default true,
  assigned_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.profiles (id)
);
create unique index project_step_assignments_one_active
  on public.project_step_assignments (project_service_id, task_code) where active;
create index project_step_assignments_project_idx on public.project_step_assignments (project_id) where active;
create index project_step_assignments_user_idx on public.project_step_assignments (user_id) where active;

alter table public.project_step_assignments enable row level security;
create policy project_step_assignments_select on public.project_step_assignments for select to authenticated
  using ((select private.can_view_project(project_id)));
-- Escrita só pelas funções abaixo (sem políticas de insert/update/delete).
grant select on public.project_step_assignments to authenticated;

create trigger project_step_assignments_audit after insert or update on public.project_step_assignments
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Sub-etapas disponíveis por serviço do projeto (para o seletor da equipe).
-- Etapas já geradas vêm do cronograma; senão, do padrão que o serviço usará.
-- -----------------------------------------------------------------------------
create or replace function private.project_step_options(p_project uuid)
returns table (project_service_id uuid, service_name text, service_sort int, task_code text, task_name text,
               task_sort int, user_id uuid, from_schedule boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  p public.projects;
  ps record;
  v_tpl uuid;
begin
  select * into p from public.projects where id = p_project;
  if p.id is null or not private.can_view_project(p.id) or not private.is_staff() then
    raise exception 'Projeto não encontrado' using errcode = '42501';
  end if;

  for ps in
    select x.id, s.id as service_id, s.name, coalesce(s.sort_order, 0) as sort
    from public.project_services x join public.services s on s.id = x.service_id
    where x.project_id = p.id and x.active and x.status in ('active', 'pending_review')
  loop
    if exists (select 1 from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
               where tr.project_service_id = ps.id) then
      return query
        select ps.id, ps.name, ps.sort, t.code, t.name, t.sequence, a.user_id, true
        from public.project_tasks t
        join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
        left join public.project_step_assignments a on a.project_service_id = ps.id and a.task_code = t.code and a.active
        where tr.project_service_id = ps.id and t.code is not null and t.status <> 'cancelled' and not t.auto_skipped;
    else
      select pt.template_id into v_tpl from private.pick_template(ps.service_id, p.client_type, p.area_m2) pt;
      if v_tpl is null then
        -- Aguardando área ou variante: mostra o padrão vigente mais recente do serviço.
        select t.id into v_tpl from public.schedule_templates t
        where t.service_id = ps.service_id and t.active
          and (t.client_type is null or t.client_type = p.client_type)
        order by (t.client_type is not null) desc, t.version desc limit 1;
      end if;
      if v_tpl is not null then
        return query
          select ps.id, ps.name, ps.sort, tt.code, tt.name, tt.sort_order, a.user_id, false
          from public.template_tasks tt
          left join public.project_step_assignments a on a.project_service_id = ps.id and a.task_code = tt.code and a.active
          where tt.template_id = v_tpl and tt.active;
      end if;
    end if;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Define o conjunto completo de sub-etapas dos colaboradores indiretos.
-- p_items: [{project_service_id, task_code, user_id}]
-- -----------------------------------------------------------------------------
create or replace function private.set_step_assignments(p_project uuid, p_items jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  it jsonb;
  u public.profiles;
  r record;
  v_me uuid := private.current_profile_id();
  v_added int := 0;
  v_removed int := 0;
  v_tasks int := 0;
begin
  select * into p from public.projects where id = p_project for update;
  if p.id is null or not private.can_assign_team(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para definir a equipe' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'Formato inválido' using errcode = '22023';
  end if;

  -- Validação
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if not exists (select 1 from public.project_services x where x.id = (it ->> 'project_service_id')::uuid and x.project_id = p.id and x.active) then
      raise exception 'Serviço não pertence a este projeto' using errcode = '23514';
    end if;
    if nullif(trim(it ->> 'task_code'), '') is null then
      raise exception 'Etapa inválida' using errcode = '23514';
    end if;
    select * into u from public.profiles where id = (it ->> 'user_id')::uuid;
    if u.id is null or u.status <> 'ativo' or u.role not in ('collaborator', 'leader', 'unit_admin') then
      raise exception 'Responsável inválido ou inativo' using errcode = '23514';
    end if;
    if u.tenant_id is distinct from p.delivery_tenant_id then
      raise exception '% não pertence à unidade executora do projeto', u.name using errcode = '23514';
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)))
     <> (select count(distinct (x ->> 'project_service_id') || '|' || (x ->> 'task_code')) from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x) then
    raise exception 'Cada etapa pode ter apenas um colaborador indireto' using errcode = '23514';
  end if;

  perform private.engine_on();

  -- Vínculos que saem (ou mudam de pessoa): etapas abertas voltam para o responsável direto do serviço.
  for r in
    select a.*, x.responsible_user_id as direct
    from public.project_step_assignments a join public.project_services x on x.id = a.project_service_id
    where a.project_id = p.id and a.active
      and not exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i
                      where (i ->> 'project_service_id')::uuid = a.project_service_id and i ->> 'task_code' = a.task_code
                        and (i ->> 'user_id')::uuid = a.user_id)
  loop
    update public.project_step_assignments set active = false, removed_at = now(), removed_by = v_me where id = r.id;
    v_removed := v_removed + 1;
    update public.project_tasks t set responsible_user_id = r.direct
      from public.project_schedule_tracks tr
     where tr.id = t.schedule_track_id and tr.project_service_id = r.project_service_id and t.code = r.task_code
       and t.responsible_user_id = r.user_id and t.status not in ('completed', 'cancelled');
  end loop;

  -- Vínculos novos: grava e aplica às etapas já geradas.
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if exists (select 1 from public.project_step_assignments a
               where a.project_service_id = (it ->> 'project_service_id')::uuid and a.task_code = it ->> 'task_code'
                 and a.user_id = (it ->> 'user_id')::uuid and a.active) then
      continue;
    end if;
    insert into public.project_step_assignments (project_id, project_service_id, task_code, user_id, assigned_by)
    values (p.id, (it ->> 'project_service_id')::uuid, it ->> 'task_code', (it ->> 'user_id')::uuid, v_me);
    v_added := v_added + 1;
    perform private.ensure_project_member(p.id, (it ->> 'user_id')::uuid);

    for r in
      select t.id, t.name, t.responsible_user_id
      from public.project_tasks t join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
      where tr.project_service_id = (it ->> 'project_service_id')::uuid and t.code = it ->> 'task_code'
        and t.status not in ('completed', 'cancelled')
        and t.responsible_user_id is distinct from (it ->> 'user_id')::uuid
    loop
      update public.project_tasks set responsible_user_id = (it ->> 'user_id')::uuid where id = r.id;
      insert into public.task_changes (project_id, task_id, change_type, before, after, changed_by)
      values (p.id, r.id, 'responsible', jsonb_build_object('responsible_user_id', r.responsible_user_id),
              jsonb_build_object('responsible_user_id', (it ->> 'user_id')::uuid), v_me);
      perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Nova etapa sob sua responsabilidade',
        r.name || ' · ' || p.name, 'project_tasks', r.id, '{}'::jsonb, null, (it ->> 'user_id')::uuid);
      v_tasks := v_tasks + 1;
    end loop;
  end loop;

  return jsonb_build_object('added', v_added, 'removed', v_removed, 'tasks_updated', v_tasks);
end;
$$;

-- -----------------------------------------------------------------------------
-- Etapas que nascem depois (início do projeto, área informada, serviço novo)
-- já recebem o colaborador indireto escolhido.
-- -----------------------------------------------------------------------------
create or replace function private.apply_step_assignment()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_user uuid;
begin
  if new.code is null then return new; end if;
  select a.user_id into v_user
  from public.project_step_assignments a
  join public.project_schedule_tracks tr on tr.project_service_id = a.project_service_id
  where tr.id = new.schedule_track_id and a.task_code = new.code and a.active
  limit 1;
  if v_user is not null then
    new.responsible_user_id := v_user;
  end if;
  return new;
end;
$$;
create trigger project_tasks_step_assignment before insert on public.project_tasks
  for each row execute function private.apply_step_assignment();

-- Wrappers públicos
create or replace function public.project_step_options(p_project uuid)
returns table (project_service_id uuid, service_name text, service_sort int, task_code text, task_name text,
               task_sort int, user_id uuid, from_schedule boolean)
language sql stable security invoker set search_path = '' as $$ select * from private.project_step_options(p_project) $$;
create or replace function public.set_step_assignments(p_project uuid, p_items jsonb) returns jsonb
language sql security invoker set search_path = '' as $$ select private.set_step_assignments(p_project, p_items) $$;

revoke all on function public.project_step_options(uuid), public.set_step_assignments(uuid, jsonb) from public, anon;
grant execute on function public.project_step_options(uuid), public.set_step_assignments(uuid, jsonb) to authenticated;
revoke all on function private.project_step_options(uuid), private.set_step_assignments(uuid, jsonb), private.apply_step_assignment() from public, anon;
grant execute on function private.project_step_options(uuid), private.set_step_assignments(uuid, jsonb) to authenticated, service_role;
