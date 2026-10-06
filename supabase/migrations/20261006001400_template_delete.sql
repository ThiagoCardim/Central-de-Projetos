-- =============================================================================
-- Portal de Projetos YouCon — Migration 0014 (Etapa 3): excluir padrão YouCon.
--
-- "Excluir" retira a variante de uso (todas as versões ficam arquivadas e o
-- serviço passa a "Sem cronograma padrão" para novos projetos). O histórico é
-- preservado: projetos já gerados continuam com as etapas que receberam.
-- Segurança: exige digitar o nome do serviço, validado também no servidor.
-- =============================================================================

create or replace function private.delete_template_variant(p_template uuid, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  tpl public.schedule_templates;
  s public.services;
  v_versions int;
  v_projects int;
begin
  if not private.can_manage_templates() then
    raise exception 'Somente o ADM Global altera o padrão YouCon' using errcode = '42501';
  end if;
  select * into tpl from public.schedule_templates where id = p_template;
  if tpl.id is null then raise exception 'Padrão não encontrado' using errcode = 'P0002'; end if;
  select * into s from public.services where id = tpl.service_id;
  if lower(trim(coalesce(p_confirm, ''))) <> lower(trim(s.name)) then
    raise exception 'Para excluir, digite exatamente o nome do serviço: %', s.name using errcode = '23514';
  end if;

  select count(distinct tr.project_id) into v_projects
  from public.project_schedule_tracks tr
  join public.schedule_templates t on t.id = tr.template_id
  join public.projects p on p.id = tr.project_id
  where t.service_id = tpl.service_id and t.client_type is not distinct from tpl.client_type
    and t.area_min is not distinct from tpl.area_min and t.area_max is not distinct from tpl.area_max
    and p.status in ('in_progress', 'on_hold');

  update public.schedule_templates
     set active = false,
         status = 'archived',
         notes = case when status = 'draft' then 'Rascunho descartado na exclusão do padrão'
                      when active then concat_ws(' · ', nullif(notes, ''), 'Padrão excluído')
                      else notes end
   where service_id = tpl.service_id and client_type is not distinct from tpl.client_type
     and area_min is not distinct from tpl.area_min and area_max is not distinct from tpl.area_max
     and (active or status = 'draft');
  get diagnostics v_versions = row_count;

  perform private.log_audit('template_deleted', 'schedule_templates', tpl.id, null,
    jsonb_build_object('service', s.name, 'client_type', tpl.client_type, 'area_min', tpl.area_min, 'area_max', tpl.area_max,
                       'projects_in_progress', v_projects));
  return jsonb_build_object('archived', v_versions, 'projects_in_progress', v_projects);
end;
$$;

-- Quantos projetos em andamento usam cada variante (exibido antes de excluir).
create or replace function private.template_usage(p_service uuid)
returns table (template_id uuid, projects_in_progress int)
language sql stable security definer set search_path = ''
as $$
  select t.id, count(distinct tr.project_id) filter (where p.status in ('in_progress', 'on_hold'))::int
  from public.schedule_templates t
  left join public.project_schedule_tracks tr on tr.template_id = t.id
  left join public.projects p on p.id = tr.project_id
  where t.service_id = p_service and private.is_staff()
  group by t.id
$$;

create or replace function public.delete_template_variant(p_template uuid, p_confirm text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.delete_template_variant(p_template, p_confirm) $$;
create or replace function public.template_usage(p_service uuid)
returns table (template_id uuid, projects_in_progress int)
language sql stable security invoker set search_path = '' as $$ select * from private.template_usage(p_service) $$;

revoke all on function public.delete_template_variant(uuid, text), public.template_usage(uuid) from public, anon;
grant execute on function public.delete_template_variant(uuid, text), public.template_usage(uuid) to authenticated;
revoke all on function private.delete_template_variant(uuid, text), private.template_usage(uuid) from public, anon;
grant execute on function private.delete_template_variant(uuid, text), private.template_usage(uuid) to authenticated, service_role;
