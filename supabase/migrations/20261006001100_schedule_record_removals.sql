-- =============================================================================
-- Portal de Projetos YouCon — Migration 0011 (Etapa 3): remover dependência
-- manual entre etapas de um projeto (apaga somente a ligação; o histórico
-- registra quem removeu, quando e o motivo).
-- =============================================================================

create or replace function private.remove_task_dependency(p_task uuid, p_depends_on uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  v_ids uuid[];
begin
  t := private.task_for_edit(p_task, true);
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Informe o motivo da remoção da dependência' using errcode = '23514';
  end if;
  perform private.engine_on();
  delete from public.task_dependencies where task_id = t.id and depends_on_task_id = p_depends_on;
  if not found then raise exception 'Dependência não encontrada' using errcode = 'P0002'; end if;
  v_ids := private.apply_schedule(t.project_id);
  insert into public.task_changes (project_id, task_id, change_type, before, reason, impacted_task_ids, changed_by)
  values (t.project_id, t.id, 'dependency', jsonb_build_object('removed', p_depends_on), trim(p_reason), v_ids, private.current_profile_id());
  return jsonb_build_object('impacted_count', coalesce(array_length(v_ids, 1), 0));
end;
$$;



create or replace function public.remove_task_dependency(p_task uuid, p_depends_on uuid, p_reason text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.remove_task_dependency(p_task, p_depends_on, p_reason) $$;



revoke all on function public.remove_task_dependency(uuid, uuid, text) from public, anon;
grant execute on function public.remove_task_dependency(uuid, uuid, text) to authenticated;
revoke all on function private.remove_task_dependency(uuid, uuid, text) from public, anon;
grant execute on function private.remove_task_dependency(uuid, uuid, text) to authenticated, service_role;
