-- =============================================================================
-- Portal de Projetos YouCon — Migration 0012 (Etapa 3): equipe por serviço,
-- colaboradores indiretos, biblioteca de etapas, etapas extras no projeto e
-- foto de perfil.
--
--   * Responsável direto por serviço contratado (contato com o cliente).
--     As etapas do serviço nascem com esse responsável.
--   * Qualquer etapa aceita responsável próprio; quem não é da equipe entra
--     como "Colaborador indireto" e passa a ver o projeto.
--   * Biblioteca de etapas: nomes registrados para reutilizar em templates e
--     em etapas extras de um projeto.
--   * Foto de perfil em Storage (bucket "avatars"), editável pela própria
--     pessoa ou por quem administra os usuários da unidade.
-- =============================================================================

alter table public.project_services
  add column responsible_user_id uuid references public.profiles(id) on delete set null;
create index project_services_responsible_idx on public.project_services (responsible_user_id) where responsible_user_id is not null;

insert into public.project_roles (code, name, sort_order, required)
values ('support', 'Colaborador indireto', 90, false)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Biblioteca de etapas
-- -----------------------------------------------------------------------------
create table public.task_library (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (length(trim(name)) between 2 and 120),
  description           text,
  family_id             uuid references public.service_families(id) on delete set null,
  default_duration_days int check (default_duration_days is null or default_duration_days between 1 and 2000),
  duration_type         public.duration_type not null default 'fixed',
  active                boolean not null default true,
  created_by            uuid references public.profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint task_library_duration_chk check (duration_type = 'fixed' or default_duration_days is null)
);
create unique index task_library_name_uidx on public.task_library (lower(trim(name)));
create trigger task_library_touch before update on public.task_library
  for each row execute function private.touch_updated_at();
create trigger task_library_audit after insert or update or delete on public.task_library
  for each row execute function private.audit_row();

alter table public.task_library enable row level security;
create policy task_library_select on public.task_library for select to authenticated using (private.is_staff());
create policy task_library_insert on public.task_library for insert to authenticated with check (private.is_manager());
create policy task_library_update on public.task_library for update to authenticated
  using (private.is_global_admin() or (private.is_manager() and created_by = private.current_profile_id()))
  with check (private.is_global_admin() or (private.is_manager() and created_by = private.current_profile_id()));
revoke all on public.task_library from anon;
grant select, insert, update on public.task_library to authenticated;

-- Etapas já usadas nos padrões YouCon + sub-etapas citadas pela operação.
-- Prazos não informados ficam em branco (a definir).
insert into public.task_library (name, duration_type)
select distinct on (lower(tt.name)) tt.name, 'fixed'::public.duration_type
from public.template_tasks tt
join public.schedule_templates st on st.id = tt.template_id and st.active
where tt.duration_type = 'fixed'
on conflict do nothing;
insert into public.task_library (name, duration_type) values
  ('Projeto Executivo', 'fixed'), ('Imagens 3D', 'fixed'), ('Vídeo 3D', 'fixed'), ('Detalhamento', 'fixed')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Atribuição de equipe: Líder + responsável direto por serviço + indiretos.
-- p_assignments aceita:
--   {"project_role": "project_lead", "user_id": "..."}
--   {"project_service_id": "...", "user_id": "..."}      responsável direto
--   {"project_role": "support", "user_id": "..."}        colaborador indireto
--   {"project_role": "<função>", "user_id": "..."}       (compatível com a Etapa 2)
-- -----------------------------------------------------------------------------
create or replace function private.assign_project_team(p_project uuid, p_assignments jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.projects;
  a jsonb;
  u public.profiles;
  ps record;
  v_new int := 0;
  v_removed int := 0;
  v_started boolean := false;
  v_desired jsonb := '[]'::jsonb;
  v_resp uuid;
  d jsonb;
begin
  select * into p from public.projects where id = p_project for update;
  if p.id is null or not private.can_assign_team(p.id) then
    raise exception 'Projeto não encontrado ou sem permissão para definir a equipe' using errcode = '42501';
  end if;
  if p.status not in ('awaiting_team_assignment', 'in_progress', 'on_hold') then
    raise exception 'A equipe só pode ser definida após a distribuição do projeto' using errcode = '23514';
  end if;
  if jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    raise exception 'Defina ao menos o Líder do Projeto' using errcode = '23514';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_assignments) x where x ->> 'project_role' = 'project_lead') then
    raise exception 'O Líder do Projeto é obrigatório' using errcode = '23514';
  end if;

  for a in select * from jsonb_array_elements(p_assignments) loop
    if nullif(a ->> 'user_id', '') is null then continue; end if;
    select * into u from public.profiles where id = (a ->> 'user_id')::uuid;
    if u.id is null or u.status <> 'ativo' or u.role not in ('collaborator', 'leader', 'unit_admin') then
      raise exception 'Responsável inválido ou inativo' using errcode = '23514';
    end if;
    if u.tenant_id is distinct from p.delivery_tenant_id then
      raise exception '% não pertence à unidade executora do projeto', u.name using errcode = '23514';
    end if;

    if nullif(a ->> 'project_service_id', '') is not null then
      select x.id, f.default_project_role into ps
      from public.project_services x
      join public.services s on s.id = x.service_id
      left join public.service_families f on f.id = s.family_id
      where x.id = (a ->> 'project_service_id')::uuid and x.project_id = p.id and x.active;
      if ps.id is null then raise exception 'Serviço não pertence a este projeto' using errcode = '23514'; end if;
      v_desired := v_desired || jsonb_build_object('role', coalesce(ps.default_project_role, 'support'), 'user', u.id);
    else
      if not exists (select 1 from public.project_roles r where r.code = a ->> 'project_role' and r.active) then
        raise exception 'Função de equipe inválida: %', a ->> 'project_role' using errcode = '23514';
      end if;
      v_desired := v_desired || jsonb_build_object('role', a ->> 'project_role', 'user', u.id);
    end if;
  end loop;

  -- Remove vínculos que saíram
  update public.project_team t
     set active = false, removed_at = now(), removed_by = private.current_profile_id()
   where t.project_id = p.id and t.active
     and not exists (select 1 from jsonb_array_elements(v_desired) x
                     where (x ->> 'user')::uuid = t.user_id and x ->> 'role' = t.project_role);
  get diagnostics v_removed = row_count;

  -- Cria vínculos novos
  for d in select distinct x from jsonb_array_elements(v_desired) x loop
    if not exists (select 1 from public.project_team t where t.project_id = p.id and t.active
                   and t.user_id = (d ->> 'user')::uuid and t.project_role = d ->> 'role') then
      select * into u from public.profiles where id = (d ->> 'user')::uuid;
      insert into public.project_team (project_id, user_id, project_role, employment_type, assigned_by)
      values (p.id, u.id, d ->> 'role', u.employment_type, private.current_profile_id());
      v_new := v_new + 1;
      if not exists (select 1 from public.project_team t where t.project_id = p.id and t.active and t.user_id = u.id
                     and t.project_role <> d ->> 'role') then
        perform private.notify(p.delivery_tenant_id, 'team_assigned', 'Você foi incluído em um projeto', p.name,
          'projects', p.id, jsonb_build_object('project_role', d ->> 'role'), null, u.id);
      end if;
    end if;
  end loop;

  -- Responsável direto de cada serviço; etapas abertas acompanham a troca.
  perform private.engine_on();
  for ps in select x.id, x.responsible_user_id from public.project_services x where x.project_id = p.id and x.active loop
    select nullif(x ->> 'user_id', '')::uuid into v_resp
    from jsonb_array_elements(p_assignments) x where x ->> 'project_service_id' = ps.id::text limit 1;
    if v_resp is distinct from ps.responsible_user_id then
      update public.project_services set responsible_user_id = v_resp where id = ps.id;
      update public.project_tasks t set responsible_user_id = v_resp
        from public.project_schedule_tracks tr
       where tr.id = t.schedule_track_id and tr.project_service_id = ps.id
         and t.status not in ('completed', 'cancelled')
         and (t.responsible_user_id is null or t.responsible_user_id is not distinct from ps.responsible_user_id);
    end if;
  end loop;

  if p.status = 'awaiting_team_assignment' then
    update public.projects set status = 'in_progress', started_at = now() where id = p.id;  -- gera o cronograma
    v_started := true;
  end if;
  perform private.resolve_notifications('project_awaiting_team', p.id);
  perform private.log_audit(case when v_started then 'team_confirmed_project_started' else 'team_changed' end,
    'projects', p.id, p.delivery_tenant_id,
    jsonb_build_object('assignments', p_assignments, 'added', v_new, 'removed', v_removed));

  return jsonb_build_object('project_id', p.id, 'started', v_started, 'added', v_new, 'removed', v_removed);
end;
$$;

-- Garante vínculo de colaborador indireto (quem recebe uma etapa sem estar na equipe).
create or replace function private.ensure_project_member(p_project uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare u public.profiles;
begin
  if p_user is null or exists (select 1 from public.project_team where project_id = p_project and user_id = p_user and active) then
    return;
  end if;
  select * into u from public.profiles where id = p_user;
  insert into public.project_team (project_id, user_id, project_role, employment_type, assigned_by)
  values (p_project, p_user, 'support', u.employment_type, private.current_profile_id());
end;
$$;

-- -----------------------------------------------------------------------------
-- Geração: etapas nascem com o responsável direto do serviço.
-- (mesma lógica da migration 0010, acrescentando o responsável)
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
    select x.id, x.service_id, x.responsible_user_id from public.project_services x
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
                                      duration_type, planned_duration_days, client_visible, status, responsible_user_id)
    select tr.id, p.id, tt.id, tt.code, tt.name, tt.description, tt.sort_order,
           tt.duration_type, tt.default_duration_days, tt.client_visible, 'not_started', ps.responsible_user_id
    from public.template_tasks tt
    where tt.template_id = pick.template_id and tt.active
      and (tt.include_if_service_codes is null or tt.include_if_service_codes && v_codes);
    get diagnostics v_n = row_count;
    v_tasks := v_tasks + v_n;

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

-- Responsável de etapa: qualquer pessoa ativa da unidade executora; quem não é
-- da equipe entra como colaborador indireto.
create or replace function private.set_task_responsible(p_task uuid, p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
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
  update public.project_tasks set responsible_user_id = p_user where id = t.id;
  perform private.ensure_project_member(t.project_id, p_user);
  insert into public.task_changes (project_id, task_id, change_type, before, after, changed_by)
  values (t.project_id, t.id, 'responsible', jsonb_build_object('responsible_user_id', t.responsible_user_id),
          jsonb_build_object('responsible_user_id', p_user), private.current_profile_id());
  if p_user is not null then
    perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Nova etapa sob sua responsabilidade',
      t.name || ' · ' || p.name, 'project_tasks', t.id, '{}'::jsonb, null, p_user);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Etapa extra num projeto ("Ajustar este projeto"): da biblioteca ou nova.
--   p_after:       etapa após a qual entra (mesma trilha); null = início da trilha
--   p_in_sequence: true = as etapas que vinham depois de p_after passam a esperar a nova
-- -----------------------------------------------------------------------------
create or replace function private.add_project_task(
  p_track uuid, p_after uuid, p_name text, p_description text, p_duration int,
  p_duration_type public.duration_type, p_responsible uuid, p_in_sequence boolean,
  p_reason text, p_save_to_library boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  tr public.project_schedule_tracks;
  p public.projects;
  aft public.project_tasks;
  u public.profiles;
  v_id uuid := gen_random_uuid();
  v_seq int;
  v_ids uuid[];
  v_type public.duration_type := coalesce(p_duration_type, 'fixed');
begin
  select * into tr from public.project_schedule_tracks where id = p_track;
  if tr.id is null or not private.can_edit_schedule(tr.project_id) then
    raise exception 'Trilha não encontrada ou sem permissão' using errcode = '42501';
  end if;
  select * into p from public.projects where id = tr.project_id;
  if p.status not in ('in_progress', 'on_hold') then
    raise exception 'Etapas extras só em projetos em andamento' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Informe o nome da etapa' using errcode = '23514'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'Informe o motivo da nova etapa' using errcode = '23514'; end if;
  if v_type = 'dependent' then
    raise exception 'Etapas extras não podem ser do tipo dependente' using errcode = '23514';
  end if;
  if v_type = 'ongoing' then p_duration := null; end if;
  if p_duration is not null and (p_duration < 1 or p_duration > 2000) then
    raise exception 'Duração deve ser de 1 a 2000 dias úteis' using errcode = '23514';
  end if;
  if p_after is not null then
    select * into aft from public.project_tasks where id = p_after and schedule_track_id = tr.id;
    if aft.id is null then raise exception 'A etapa de referência deve ser deste serviço' using errcode = '23514'; end if;
  end if;
  if p_responsible is not null then
    select * into u from public.profiles where id = p_responsible;
    if u.id is null or u.status <> 'ativo' or u.role not in ('collaborator', 'leader', 'unit_admin')
       or u.tenant_id is distinct from p.delivery_tenant_id then
      raise exception 'O responsável precisa ser uma pessoa ativa da unidade executora' using errcode = '23514';
    end if;
  end if;

  perform private.engine_on();
  v_seq := coalesce(aft.sequence, 0) + 1;
  update public.project_tasks set sequence = sequence + 1 where schedule_track_id = tr.id and sequence >= v_seq;

  insert into public.project_tasks (id, schedule_track_id, project_id, code, name, description, sequence, duration_type,
                                    planned_duration_days, status, responsible_user_id)
  values (v_id, tr.id, p.id, 'extra_' || left(private.slug(p_name), 40), trim(p_name), nullif(trim(coalesce(p_description, '')), ''),
          v_seq, v_type, p_duration, 'not_started', coalesce(p_responsible, (select responsible_user_id from public.project_services where id = tr.project_service_id)));

  if aft.id is not null then
    if p_in_sequence then
      update public.task_dependencies d set depends_on_task_id = v_id
        from public.project_tasks s
       where s.id = d.task_id and s.schedule_track_id = tr.id and d.depends_on_task_id = aft.id and d.task_id <> v_id;
    end if;
    insert into public.task_dependencies (task_id, depends_on_task_id, source, created_by)
    values (v_id, aft.id, 'manual', private.current_profile_id());
  elsif p_in_sequence then
    -- No início da trilha: as primeiras etapas passam a esperar a nova.
    insert into public.task_dependencies (task_id, depends_on_task_id, source, created_by)
    select s.id, v_id, 'manual', private.current_profile_id()
    from public.project_tasks s
    where s.schedule_track_id = tr.id and s.id <> v_id
      and not exists (select 1 from public.task_dependencies d join public.project_tasks x on x.id = d.depends_on_task_id
                      where d.task_id = s.id and x.schedule_track_id = tr.id);
  end if;

  if tr.status in ('no_template', 'awaiting_area') then
    update public.project_schedule_tracks set status = 'planned', base_date = coalesce(base_date, current_date) where id = tr.id;
  end if;
  perform private.ensure_project_member(p.id, (select responsible_user_id from public.project_tasks where id = v_id));

  if p_save_to_library and not exists (select 1 from public.task_library where lower(trim(name)) = lower(trim(p_name))) then
    insert into public.task_library (name, description, default_duration_days, duration_type, created_by)
    values (trim(p_name), nullif(trim(coalesce(p_description, '')), ''), case when v_type = 'fixed' then p_duration end,
            case when v_type = 'external' then 'external'::public.duration_type else v_type end, private.current_profile_id());
  end if;

  v_ids := private.apply_schedule(p.id);
  insert into public.task_changes (project_id, task_id, change_type, after, reason, impacted_task_ids, changed_by)
  values (p.id, v_id, 'created', jsonb_build_object('name', trim(p_name), 'after_task', p_after, 'in_sequence', p_in_sequence),
          trim(p_reason), array_remove(v_ids, v_id), private.current_profile_id());
  if p_responsible is not null then
    perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Nova etapa sob sua responsabilidade',
      trim(p_name) || ' · ' || p.name, 'project_tasks', v_id, '{}'::jsonb, null, p_responsible);
  end if;

  return jsonb_build_object('task_id', v_id, 'impacted_count', coalesce(array_length(array_remove(v_ids, v_id), 1), 0));
end;
$$;

-- -----------------------------------------------------------------------------
-- Cálculo: etapa iniciada antes do previsto não gera término anterior ao início.
-- (mesma lógica da migration 0010 com esse ajuste)
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
      -- Começou antes do previsto: o término previsto nunca fica antes do início previsto.
      if v_end is not null and v_start is not null and v_end < v_start then v_end := v_start; end if;
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
-- Foto de perfil
-- -----------------------------------------------------------------------------
create or replace function private.can_edit_avatar(p_profile text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare v_tenant uuid;
begin
  begin
    select tenant_id into v_tenant from public.profiles where id = p_profile::uuid;
  exception when others then return false;
  end;
  if v_tenant is null then return false; end if;
  return p_profile::uuid = private.current_profile_id() or private.can_manage_users(v_tenant);
end;
$$;

create or replace function private.set_profile_avatar(p_profile uuid, p_url text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_edit_avatar(p_profile::text) then
    raise exception 'Sem permissão para alterar esta foto' using errcode = '42501';
  end if;
  if p_url is not null and p_url !~ ('/storage/v1/object/public/avatars/' || p_profile::text || '/[A-Za-z0-9._-]+(\?.*)?$') then
    raise exception 'Endereço de foto inválido' using errcode = '23514';
  end if;
  update public.profiles set avatar_url = p_url where id = p_profile;
end;
$$;

-- Bucket público de leitura (fotos de equipe), escrita restrita. Só existe no Supabase.
do $do$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set public = true, file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

    execute $p$create policy avatars_select on storage.objects for select to authenticated
      using (bucket_id = 'avatars')$p$;
    execute $p$create policy avatars_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'avatars' and private.can_edit_avatar((storage.foldername(name))[1]))$p$;
    execute $p$create policy avatars_update on storage.objects for update to authenticated
      using (bucket_id = 'avatars' and private.can_edit_avatar((storage.foldername(name))[1]))
      with check (bucket_id = 'avatars' and private.can_edit_avatar((storage.foldername(name))[1]))$p$;
  end if;
end
$do$;

-- -----------------------------------------------------------------------------
-- API pública
-- -----------------------------------------------------------------------------
create or replace function public.add_project_task(
  p_track uuid, p_after uuid, p_name text, p_description text, p_duration int,
  p_duration_type public.duration_type, p_responsible uuid, p_in_sequence boolean,
  p_reason text, p_save_to_library boolean default false) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.add_project_task(p_track, p_after, p_name, p_description, p_duration, p_duration_type,
                                       p_responsible, p_in_sequence, p_reason, p_save_to_library) $$;
create or replace function public.set_profile_avatar(p_profile uuid, p_url text) returns void
language sql security invoker set search_path = ''
as $$ select private.set_profile_avatar(p_profile, p_url) $$;

revoke all on function public.add_project_task(uuid, uuid, text, text, int, public.duration_type, uuid, boolean, text, boolean),
                       public.set_profile_avatar(uuid, text) from public, anon;
grant execute on function public.add_project_task(uuid, uuid, text, text, int, public.duration_type, uuid, boolean, text, boolean),
                          public.set_profile_avatar(uuid, text) to authenticated;

revoke all on function private.ensure_project_member(uuid, uuid), private.add_project_task(uuid, uuid, text, text, int, public.duration_type, uuid, boolean, text, boolean),
                       private.can_edit_avatar(text), private.set_profile_avatar(uuid, text) from public, anon;
grant execute on function private.add_project_task(uuid, uuid, text, text, int, public.duration_type, uuid, boolean, text, boolean),
                          private.can_edit_avatar(text), private.set_profile_avatar(uuid, text) to authenticated, service_role;
grant execute on function private.ensure_project_member(uuid, uuid) to service_role;
revoke execute on function private.compute_schedule(uuid, jsonb) from authenticated;
