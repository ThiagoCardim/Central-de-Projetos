-- =============================================================================
-- 0032 · Tarefas atribuídas pela liderança
--
--   * O líder (ou admin da unidade / admin global) agenda tarefas avulsas para
--     pessoas da equipe da sua unidade. Elas entram nas "tarefas do dia" do
--     colaborador, que só pode marcar como feita.
--   * Quem atribuiu (e a liderança da unidade) acompanha: feitas, em aberto e
--     em atraso. Tarefas pessoais (criadas pelo próprio colaborador) continuam
--     privadas.
--   * Quem pode atribuir para quem: gestor da mesma unidade (global: qualquer
--     unidade), para alguém da equipe interna de nível igual ou abaixo.
-- =============================================================================

alter table public.work_items
  add column description text check (description is null or length(description) <= 2000),
  add column assigned_by uuid references public.profiles (id) on delete set null,
  add column assigned_at timestamptz;
create index work_items_assigned_idx on public.work_items (assigned_by) where assigned_by is not null;

-- Pode liderar (ver/editar tarefas atribuídas) a pessoa alvo.
create or replace function private.can_lead_person(p_target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles me, public.profiles t
    where me.id = private.current_profile_id() and t.id = p_target and t.id <> me.id
      and me.status = 'ativo' and me.role in ('leader', 'unit_admin', 'global_admin')
      and t.role in ('collaborator', 'leader', 'unit_admin')
      and (me.role = 'global_admin' or me.tenant_id = t.tenant_id)
      and private.role_rank(t.role) <= private.role_rank(me.role))
$$;

-- Pode atribuir agora (pessoa ativa).
create or replace function private.can_assign_work(p_target uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.can_lead_person(p_target)
     and exists (select 1 from public.profiles t where t.id = p_target and t.status = 'ativo')
$$;

-- Invoker: current_user identifica a chamada direta (authenticated) e as funções internas (postgres).
create or replace function private.work_item_guard() returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  v_me uuid := private.current_profile_id();
  v_internal boolean := current_user in ('postgres', 'service_role', 'supabase_admin');
  v_owner boolean;
  v_lead boolean;
begin
  if tg_op = 'INSERT' then
    if new.owner_id is not distinct from v_me then
      new.assigned_by := null; new.assigned_at := null;           -- tarefa pessoal
    elsif v_internal then
      null;
    elsif private.can_assign_work(new.owner_id) then
      new.assigned_by := v_me; new.assigned_at := now(); new.done_at := null;
    else
      raise exception 'Tarefa de outra pessoa' using errcode = '42501';
    end if;
  elsif not v_internal then
    v_owner := old.owner_id = v_me;
    v_lead := old.assigned_by is not null and (old.assigned_by = v_me or private.can_lead_person(old.owner_id));
    if old.assigned_by is null then
      if not v_owner or new.owner_id is distinct from old.owner_id or new.assigned_by is not null then
        raise exception 'Tarefa de outra pessoa' using errcode = '42501';
      end if;
    elsif v_lead then
      -- Liderança edita título, descrição, data, vínculo e pessoa; quem marca como feita é o responsável.
      if new.done_at is distinct from old.done_at and not v_owner then
        raise exception 'Só o responsável marca a tarefa como feita' using errcode = '42501';
      end if;
      if new.owner_id is distinct from old.owner_id and not private.can_assign_work(new.owner_id) then
        raise exception 'Você não pode atribuir tarefas para esta pessoa' using errcode = '42501';
      end if;
      new.assigned_by := old.assigned_by; new.assigned_at := old.assigned_at;
    elsif v_owner then
      if (to_jsonb(new) - 'done_at' - 'updated_at') is distinct from (to_jsonb(old) - 'done_at' - 'updated_at') then
        raise exception 'Esta tarefa foi atribuída pela liderança: você pode apenas marcá-la como feita' using errcode = '42501';
      end if;
    else
      raise exception 'Tarefa de outra pessoa' using errcode = '42501';
    end if;
  end if;

  if new.project_task_id is not null then
    if tg_op = 'INSERT' or new.project_task_id is distinct from old.project_task_id then
      select t.project_id into new.project_id from public.project_tasks t where t.id = new.project_task_id;
      if new.project_id is null or not (v_internal or private.can_view_project(new.project_id)) then
        raise exception 'Etapa não encontrada' using errcode = 'P0002';
      end if;
    end if;
  elsif new.project_id is not null and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id) then
    if not (v_internal or private.can_view_project(new.project_id)) then
      raise exception 'Projeto não encontrado' using errcode = 'P0002';
    end if;
  end if;
  new.title := trim(new.title);
  new.description := nullif(trim(new.description), '');
  return new;
end;
$$;

-- Políticas: o dono vê tudo o que é seu; a liderança vê só as tarefas atribuídas.
alter policy work_items_select on public.work_items
  using (owner_id = (select private.current_profile_id())
         or (assigned_by is not null and (assigned_by = (select private.current_profile_id()) or private.can_lead_person(owner_id))));
alter policy work_items_insert on public.work_items
  with check ((owner_id = (select private.current_profile_id()) and (select private.is_staff()))
              or private.can_assign_work(owner_id));
alter policy work_items_update on public.work_items
  using (owner_id = (select private.current_profile_id())
         or (assigned_by is not null and (assigned_by = (select private.current_profile_id()) or private.can_lead_person(owner_id))))
  with check (owner_id = (select private.current_profile_id()) or private.can_lead_person(owner_id));
alter policy work_items_delete on public.work_items
  using ((owner_id = (select private.current_profile_id()) and assigned_by is null)
         or (assigned_by is not null and (assigned_by = (select private.current_profile_id()) or private.can_lead_person(owner_id))));

-- Linha completa (com nomes) para as telas.
create or replace function private.work_item_json(w public.work_items) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id, 'title', w.title, 'description', w.description, 'due_date', w.due_date, 'done_at', w.done_at,
    'created_at', w.created_at, 'assigned_at', w.assigned_at,
    'project_task_id', w.project_task_id, 'project_id', w.project_id,
    'project_name', p.name, 'project_code', p.code, 'step_name', t.name,
    'owner', jsonb_build_object('id', o.id, 'name', o.name, 'avatar_url', o.avatar_url, 'role', o.role, 'employment_type', o.employment_type),
    'assigned_by', case when a.id is not null then jsonb_build_object('id', a.id, 'name', a.name) end)
  from public.profiles o
  left join public.profiles a on a.id = w.assigned_by
  left join public.projects p on p.id = w.project_id
  left join public.project_tasks t on t.id = w.project_task_id
  where o.id = w.owner_id
$$;

-- Minhas tarefas do dia (pessoais e atribuídas).
create or replace function private.my_work_items() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.work_item_json(w) order by w.due_date, w.created_at), '[]'::jsonb)
  from public.work_items w
  where w.owner_id = private.current_profile_id()
    and (w.done_at is null or w.done_at >= now() - interval '60 days' or w.due_date >= current_date - 60)
$$;

-- Tarefas atribuídas que eu acompanho como liderança.
create or replace function private.team_work_items(p_since date default null) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(private.work_item_json(w) order by w.due_date, w.created_at), '[]'::jsonb)
  from public.work_items w
  where w.assigned_by is not null
    and (w.assigned_by = private.current_profile_id() or private.can_lead_person(w.owner_id))
    and (w.done_at is null or w.due_date >= coalesce(p_since, current_date - 90) or w.done_at >= coalesce(p_since, current_date - 90))
$$;

-- Pessoas para quem posso atribuir.
create or replace function private.assignable_people() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'avatar_url', t.avatar_url, 'role', t.role,
                                               'employment_type', t.employment_type) order by t.name), '[]'::jsonb)
  from public.profiles t
  where t.status = 'ativo' and t.role in ('collaborator', 'leader', 'unit_admin') and private.can_assign_work(t.id)
$$;

-- Cria a mesma tarefa para uma ou mais pessoas e avisa cada uma.
create or replace function private.assign_work_items(
  p_owners uuid[], p_title text, p_due date, p_description text default null,
  p_task uuid default null, p_project uuid default null
) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles := private.current_profile();
  v_owner uuid; v_id uuid; v_n int := 0;
  v_link text;
begin
  if coalesce(array_length(p_owners, 1), 0) = 0 then raise exception 'Escolha ao menos uma pessoa' using errcode = '23514'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'Informe a tarefa' using errcode = '23514'; end if;
  if p_due is null then raise exception 'Informe a data' using errcode = '23514'; end if;
  for v_owner in select distinct unnest(p_owners) loop
    if not private.can_assign_work(v_owner) then
      raise exception 'Você não pode atribuir tarefas para %', coalesce((select name from public.profiles where id = v_owner), 'esta pessoa')
        using errcode = '42501';
    end if;
    if p_project is not null and p_task is null and not private.can_view_project(p_project) then
      raise exception 'Projeto não encontrado' using errcode = 'P0002';
    end if;
    if p_task is not null and not exists (select 1 from public.project_tasks t where t.id = p_task and private.can_view_project(t.project_id)) then
      raise exception 'Etapa não encontrada' using errcode = 'P0002';
    end if;
    insert into public.work_items (owner_id, title, description, due_date, project_task_id, project_id, assigned_by, assigned_at)
    values (v_owner, p_title, p_description, p_due, p_task, case when p_task is null then p_project end, v_me.id, now())
    returning id into v_id;
    select coalesce(' · ' || nullif(concat_ws(' · ', coalesce(p.code, p.name), t.name), ''), '') into v_link
      from public.work_items w left join public.projects p on p.id = w.project_id left join public.project_tasks t on t.id = w.project_task_id
     where w.id = v_id;
    perform private.notify((select tenant_id from public.profiles where id = v_owner), 'work_assigned',
      'Nova tarefa de ' || v_me.name, trim(p_title) || ' · para ' || to_char(p_due, 'DD/MM') || coalesce(v_link, ''),
      'work_items', v_id, '{}'::jsonb, null, v_owner);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Avisa a nova pessoa quando a liderança troca o responsável ou a data.
create or replace function private.work_item_notify_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.assigned_by is null or new.done_at is not null then return new; end if;
  if new.owner_id is distinct from old.owner_id then
    perform private.notify((select tenant_id from public.profiles where id = new.owner_id), 'work_assigned',
      'Nova tarefa de ' || coalesce((select name from public.profiles where id = private.current_profile_id()), 'sua liderança'),
      new.title || ' · para ' || to_char(new.due_date, 'DD/MM'), 'work_items', new.id, '{}'::jsonb, null, new.owner_id);
  elsif new.due_date is distinct from old.due_date and new.owner_id <> private.current_profile_id() then
    perform private.notify((select tenant_id from public.profiles where id = new.owner_id), 'work_assigned',
      'Tarefa remarcada para ' || to_char(new.due_date, 'DD/MM'), new.title, 'work_items', new.id, '{}'::jsonb, null, new.owner_id);
  end if;
  return new;
end;
$$;
create trigger work_items_notify_change after update on public.work_items
  for each row execute function private.work_item_notify_change();

create or replace function public.my_work_items() returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.my_work_items() $$;
create or replace function public.team_work_items(p_since date default null) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.team_work_items(p_since) $$;
create or replace function public.assignable_people() returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.assignable_people() $$;
create or replace function public.assign_work_items(p_owners uuid[], p_title text, p_due date, p_description text default null,
  p_task uuid default null, p_project uuid default null) returns int
language sql security invoker set search_path = ''
as $$ select private.assign_work_items(p_owners, p_title, p_due, p_description, p_task, p_project) $$;

revoke all on function private.can_lead_person(uuid), private.can_assign_work(uuid), private.work_item_json(public.work_items),
  private.my_work_items(), private.team_work_items(date), private.assignable_people(),
  private.assign_work_items(uuid[], text, date, text, uuid, uuid),
  public.my_work_items(), public.team_work_items(date), public.assignable_people(),
  public.assign_work_items(uuid[], text, date, text, uuid, uuid) from public, anon;
grant execute on function private.can_lead_person(uuid), private.can_assign_work(uuid), private.work_item_json(public.work_items),
  private.my_work_items(), private.team_work_items(date), private.assignable_people(),
  private.assign_work_items(uuid[], text, date, text, uuid, uuid),
  public.my_work_items(), public.team_work_items(date), public.assignable_people(),
  public.assign_work_items(uuid[], text, date, text, uuid, uuid) to authenticated;
