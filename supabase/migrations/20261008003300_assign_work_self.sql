-- =============================================================================
-- 0033 · "Nova tarefa" da liderança pode incluir a própria pessoa
--
-- Quando o líder se inclui entre os responsáveis, a tarefa dele é pessoal
-- (sem "atribuída por") e não gera aviso; as demais seguem as regras da 0032.
-- =============================================================================

create or replace function private.assign_work_items(
  p_owners uuid[], p_title text, p_due date, p_description text default null,
  p_task uuid default null, p_project uuid default null
) returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_me public.profiles := private.current_profile();
  v_owner uuid; v_id uuid; v_n int := 0;
  v_self boolean;
  v_link text;
begin
  if v_me.id is null or not private.is_staff() then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if coalesce(array_length(p_owners, 1), 0) = 0 then raise exception 'Escolha ao menos uma pessoa' using errcode = '23514'; end if;
  if nullif(trim(p_title), '') is null then raise exception 'Informe a tarefa' using errcode = '23514'; end if;
  if p_due is null then raise exception 'Informe a data' using errcode = '23514'; end if;
  if p_project is not null and p_task is null and not private.can_view_project(p_project) then
    raise exception 'Projeto não encontrado' using errcode = 'P0002';
  end if;
  if p_task is not null and not exists (select 1 from public.project_tasks t where t.id = p_task and private.can_view_project(t.project_id)) then
    raise exception 'Etapa não encontrada' using errcode = 'P0002';
  end if;

  for v_owner in select distinct unnest(p_owners) loop
    v_self := v_owner = v_me.id;
    if not v_self and not private.can_assign_work(v_owner) then
      raise exception 'Você não pode atribuir tarefas para %', coalesce((select name from public.profiles where id = v_owner), 'esta pessoa')
        using errcode = '42501';
    end if;
    insert into public.work_items (owner_id, title, description, due_date, project_task_id, project_id, assigned_by, assigned_at)
    values (v_owner, p_title, p_description, p_due, p_task, case when p_task is null then p_project end,
            case when v_self then null else v_me.id end, case when v_self then null else now() end)
    returning id into v_id;
    if not v_self then
      select coalesce(' · ' || nullif(concat_ws(' · ', coalesce(p.code, p.name), t.name), ''), '') into v_link
        from public.work_items w left join public.projects p on p.id = w.project_id left join public.project_tasks t on t.id = w.project_task_id
       where w.id = v_id;
      perform private.notify((select tenant_id from public.profiles where id = v_owner), 'work_assigned',
        'Nova tarefa de ' || v_me.name, trim(p_title) || ' · para ' || to_char(p_due, 'DD/MM') || coalesce(v_link, ''),
        'work_items', v_id, '{}'::jsonb, null, v_owner);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
