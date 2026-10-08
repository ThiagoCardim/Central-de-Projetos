-- =============================================================================
-- 0030 · Observações da etapa como registro (com autor e data)
--
-- Antes: um campo único (project_tasks.notes) sobrescrito a cada salvamento,
-- sem autor nem histórico. Agora cada observação é um registro próprio:
--   * Quem é da equipe e vê o projeto pode adicionar.
--   * Aparece na lista de observações e no histórico da etapa.
--   * O responsável pela etapa é avisado quando outra pessoa comenta.
--   * As observações antigas viram o primeiro registro de cada etapa.
-- =============================================================================

create table public.task_notes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  task_id    uuid not null references public.project_tasks (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null,
  body       text not null check (length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index task_notes_task_idx on public.task_notes (task_id, created_at desc);
create trigger task_notes_audit after insert on public.task_notes for each row execute function private.audit_row();
alter table public.task_notes enable row level security;
create policy task_notes_select on public.task_notes for select to authenticated
  using (private.is_staff() and private.can_view_project(project_id));
revoke all on public.task_notes from anon;
grant select on public.task_notes to authenticated;

-- Observações já gravadas no campo antigo
insert into public.task_notes (project_id, task_id, author_id, body, created_at)
select t.project_id, t.id, null, trim(t.notes), t.updated_at
from public.project_tasks t
where length(trim(coalesce(t.notes, ''))) > 0
  and not exists (select 1 from public.task_notes n where n.task_id = t.id);

create or replace function private.add_task_note(p_task uuid, p_body text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  p public.projects;
  v_id uuid;
  v_me uuid := private.current_profile_id();
begin
  select * into t from public.project_tasks where id = p_task;
  if t.id is null or not private.is_staff() or not private.can_view_project(t.project_id) then
    raise exception 'Etapa não encontrada' using errcode = 'P0002';
  end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'Escreva a observação' using errcode = '23514'; end if;
  if length(trim(p_body)) > 4000 then raise exception 'Observação muito longa (até 4000 caracteres)' using errcode = '23514'; end if;

  insert into public.task_notes (project_id, task_id, author_id, body)
  values (t.project_id, t.id, v_me, trim(p_body)) returning id into v_id;

  if t.responsible_user_id is not null and t.responsible_user_id is distinct from v_me then
    select * into p from public.projects where id = t.project_id;
    perform private.notify(p.delivery_tenant_id, 'task_note', 'Nova observação na sua etapa',
      t.name || ' · ' || p.name || ': ' || left(trim(p_body), 140), 'project_tasks', t.id, '{}'::jsonb, null, t.responsible_user_id);
  end if;
  return v_id;
end;
$$;

create or replace function public.add_task_note(p_task uuid, p_body text) returns uuid
language sql security invoker set search_path = '' as $$ select private.add_task_note(p_task, p_body) $$;
revoke all on function private.add_task_note(uuid, text), public.add_task_note(uuid, text) from public, anon;
grant execute on function private.add_task_note(uuid, text), public.add_task_note(uuid, text) to authenticated;
