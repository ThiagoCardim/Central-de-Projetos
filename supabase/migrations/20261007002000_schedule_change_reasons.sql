-- =============================================================================
-- 0020 · Motivos padronizados para alteração de prazo + histórico visível ao cliente
--
--   * public.schedule_change_reasons: lista configurável de motivos (ADM Global edita).
--     Cada motivo diz se aparece para o cliente (client_visible).
--   * task_changes ganha reason_id. O texto do motivo continua em task_changes.reason
--     (rótulo do motivo escolhido ou o texto livre de "Outro motivo").
--   * reschedule_task_with_reason(): exige um motivo da lista; "Outro motivo"
--     (is_other) exige texto livre.
--   * client_schedule_changes(): alterações de prazo das etapas visíveis ao cliente,
--     somente dos projetos que o usuário pode ver e de motivos marcados para o cliente.
-- =============================================================================

create table public.schedule_change_reasons (
  id             uuid primary key default gen_random_uuid(),
  label          text not null check (length(trim(label)) between 3 and 120),
  description    text,
  client_visible boolean not null default true,
  is_other       boolean not null default false,
  sort_order     int not null default 100,
  active         boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index schedule_change_reasons_label_uidx on public.schedule_change_reasons (lower(trim(label)));
-- Só pode existir um "Outro motivo".
create unique index schedule_change_reasons_other_uidx on public.schedule_change_reasons (is_other) where is_other;
create trigger schedule_change_reasons_touch before update on public.schedule_change_reasons
  for each row execute function private.touch_updated_at();
create trigger schedule_change_reasons_audit after insert or update or delete on public.schedule_change_reasons
  for each row execute function private.audit_row();

alter table public.schedule_change_reasons enable row level security;
create policy schedule_change_reasons_select on public.schedule_change_reasons for select to authenticated
  using (private.is_staff());
create policy schedule_change_reasons_insert on public.schedule_change_reasons for insert to authenticated
  with check (private.is_global_admin() and not is_other);
create policy schedule_change_reasons_update on public.schedule_change_reasons for update to authenticated
  using (private.is_global_admin()) with check (private.is_global_admin());
revoke all on public.schedule_change_reasons from anon;
grant select, insert, update on public.schedule_change_reasons to authenticated;

insert into public.schedule_change_reasons (label, client_visible, is_other, sort_order) values
  ('Solicitação do cliente', true, false, 10),
  ('Aguardando aprovação ou retorno do cliente', true, false, 20),
  ('Atraso no envio de informações ou documentos pelo cliente', true, false, 30),
  ('Alteração de escopo solicitada pelo cliente', true, false, 40),
  ('Inclusão de novo serviço (aditivo)', true, false, 50),
  ('Prazo de órgão público ou concessionária', true, false, 60),
  ('Dependência de fornecedor ou terceiro', true, false, 70),
  ('Revisão técnica ou compatibilização entre projetos', true, false, 80),
  ('Reorganização interna da equipe', false, false, 90),
  ('Antecipação de prazo', true, false, 95),
  ('Outro motivo', true, true, 1000)
on conflict do nothing;

alter table public.task_changes add column reason_id uuid references public.schedule_change_reasons(id) on delete set null;

-- -----------------------------------------------------------------------------
-- Reprogramação com motivo padronizado
-- -----------------------------------------------------------------------------
create or replace function private.reschedule_task_with_reason(p_task uuid, p_start date, p_duration int,
  p_reason_id uuid, p_reason_text text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.schedule_change_reasons;
  v_text text := nullif(trim(coalesce(p_reason_text, '')), '');
  v_reason text;
  v_res jsonb;
  v_change uuid;
begin
  select * into r from public.schedule_change_reasons where id = p_reason_id and active;
  if r.id is null then
    raise exception 'Selecione o motivo da alteração de prazo' using errcode = '23514';
  end if;
  if r.is_other then
    if v_text is null or length(v_text) < 3 then
      raise exception 'Descreva o motivo da alteração' using errcode = '23514';
    end if;
    v_reason := v_text;
  else
    v_reason := r.label || coalesce(' · ' || v_text, '');
  end if;

  v_res := private.reschedule_task(p_task, p_start, p_duration, v_reason);

  select id into v_change from public.task_changes
   where task_id = p_task and change_type in ('reschedule', 'duration') and reason_id is null
   order by created_at desc limit 1;
  update public.task_changes set reason_id = r.id where id = v_change;
  return v_res || jsonb_build_object('change_id', v_change);
end;
$$;

-- -----------------------------------------------------------------------------
-- Histórico de alterações de prazo para o cliente
--   Mostra só etapas visíveis ao cliente, motivos marcados como visíveis
--   (ou alterações sem motivo padronizado, anteriores a esta versão) e
--   projetos que o usuário pode ver.
-- -----------------------------------------------------------------------------
create or replace function private.client_schedule_changes(p_project uuid default null, p_limit int default 50)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'changed_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', c.id,
      'project_id', c.project_id,
      'project_name', p.name,
      'task_name', t.name,
      'service_name', s.name,
      'change_type', c.change_type,
      'reason', case when r.is_other or r.id is null then c.reason else r.label end,
      'reason_detail', case when r.id is not null and not r.is_other and c.reason like r.label || ' · %'
                            then substr(c.reason, length(r.label) + 4) end,
      'before_start', c.before ->> 'planned_start_date',
      'before_end', c.before ->> 'planned_end_date',
      'after_start', c.after ->> 'planned_start_date',
      'after_end', c.after ->> 'planned_end_date',
      'impacted_count', coalesce(array_length(c.impacted_task_ids, 1), 0),
      'changed_at', c.created_at
    ) as x
    from public.task_changes c
    join public.projects p on p.id = c.project_id
    join public.project_tasks t on t.id = c.task_id
    left join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
    left join public.project_services ps on ps.id = tr.project_service_id
    left join public.services s on s.id = ps.service_id
    left join public.schedule_change_reasons r on r.id = c.reason_id
    where c.change_type in ('reschedule', 'duration')
      and t.client_visible
      and coalesce(r.client_visible, true)
      and (p_project is null or c.project_id = p_project)
      and private.can_view_project(c.project_id)
    order by c.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) q
$$;

create or replace function public.reschedule_task_with_reason(p_task uuid, p_start date, p_duration int,
  p_reason_id uuid, p_reason_text text default null) returns jsonb
language sql security invoker set search_path = ''
as $$ select private.reschedule_task_with_reason(p_task, p_start, p_duration, p_reason_id, p_reason_text) $$;
create or replace function public.client_schedule_changes(p_project uuid default null, p_limit int default 50) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select private.client_schedule_changes(p_project, p_limit) $$;

revoke all on function private.reschedule_task_with_reason(uuid, date, int, uuid, text) from public, anon;
revoke all on function private.client_schedule_changes(uuid, int) from public, anon;
revoke all on function public.reschedule_task_with_reason(uuid, date, int, uuid, text) from public, anon;
revoke all on function public.client_schedule_changes(uuid, int) from public, anon;
grant execute on function private.reschedule_task_with_reason(uuid, date, int, uuid, text) to authenticated;
grant execute on function private.client_schedule_changes(uuid, int) to authenticated;
grant execute on function public.reschedule_task_with_reason(uuid, date, int, uuid, text) to authenticated;
grant execute on function public.client_schedule_changes(uuid, int) to authenticated;
