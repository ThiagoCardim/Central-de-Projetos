-- =============================================================================
-- 0031 · Minhas tarefas (espaço de trabalho de cada pessoa)
--
--   * work_items: tarefas do dia de cada pessoa (checklist pessoal). Podem ser
--     ligadas a uma etapa de projeto. Só o dono vê e edita. Não feitas em dias
--     anteriores aparecem como pendentes.
--   * my_steps(): etapas sob minha responsabilidade (abertas e concluídas
--     recentes), com projeto, serviço e datas, para as listas e a agenda.
-- =============================================================================

create table public.work_items (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default private.current_profile_id() references public.profiles (id) on delete cascade,
  project_task_id uuid references public.project_tasks (id) on delete set null,
  project_id      uuid references public.projects (id) on delete set null,
  title           text not null check (length(trim(title)) between 1 and 300),
  due_date        date not null default current_date,
  done_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index work_items_owner_idx on public.work_items (owner_id, due_date);
create trigger work_items_touch before update on public.work_items for each row execute function private.touch_updated_at();

-- Ligação com etapa: só etapas de projetos que a pessoa vê; o projeto vem da etapa.
create or replace function private.work_item_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.owner_id is distinct from private.current_profile_id() and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'Tarefa de outra pessoa' using errcode = '42501';
  end if;
  if new.project_task_id is not null then
    select t.project_id into new.project_id from public.project_tasks t where t.id = new.project_task_id;
    if new.project_id is null or not private.can_view_project(new.project_id) then
      raise exception 'Etapa não encontrada' using errcode = 'P0002';
    end if;
  else
    new.project_id := null;
  end if;
  new.title := trim(new.title);
  return new;
end;
$$;
create trigger work_items_guard before insert or update on public.work_items
  for each row execute function private.work_item_guard();

alter table public.work_items enable row level security;
create policy work_items_select on public.work_items for select to authenticated
  using (owner_id = (select private.current_profile_id()));
create policy work_items_insert on public.work_items for insert to authenticated
  with check (owner_id = (select private.current_profile_id()) and (select private.is_staff()));
create policy work_items_update on public.work_items for update to authenticated
  using (owner_id = (select private.current_profile_id())) with check (owner_id = (select private.current_profile_id()));
create policy work_items_delete on public.work_items for delete to authenticated
  using (owner_id = (select private.current_profile_id()));
revoke all on public.work_items from anon;
grant select, insert, update, delete on public.work_items to authenticated;

-- Minhas etapas
create or replace function private.my_steps(p_done_since date default null) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'planned_end_date' nulls last), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', t.id, 'name', t.name, 'status', t.status,
      'project_id', p.id, 'project_name', p.name, 'project_code', p.code, 'client_name', c.name,
      'service_name', s.name,
      'planned_start_date', t.planned_start_date, 'planned_end_date', t.planned_end_date,
      'planned_duration_days', t.planned_duration_days, 'duration_type', t.duration_type,
      'actual_start_date', t.actual_start_date, 'actual_end_date', t.actual_end_date,
      'start_not_before', t.start_not_before, 'waiting_reason', t.waiting_reason,
      'reopen_count', t.reopen_count, 'status_changed_at', t.status_changed_at
    ) as x
    from public.project_tasks t
    join public.projects p on p.id = t.project_id
    left join public.clients c on c.id = p.client_id
    join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
    join public.project_services ps on ps.id = tr.project_service_id
    join public.services s on s.id = ps.service_id
    where t.responsible_user_id = private.current_profile_id()
      and p.status <> 'cancelled'
      and t.status <> 'cancelled'
      and (t.status <> 'completed' or t.actual_end_date >= coalesce(p_done_since, current_date - 60))
  ) q
$$;
create or replace function public.my_steps(p_done_since date default null) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.my_steps(p_done_since) $$;
revoke all on function private.my_steps(date), public.my_steps(date) from public, anon;
grant execute on function private.my_steps(date), public.my_steps(date) to authenticated;
