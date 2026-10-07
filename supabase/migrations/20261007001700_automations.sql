-- =============================================================================
-- Portal de Projetos YouCon — Migration 0017 (Etapa 3.1): ferramenta de automações.
--
-- Cada unidade configura regras "Quando <gatilho> [e condições] → então <ações>".
--   Gatilhos: projeto entrou, status do projeto mudou, etapa iniciada/concluída/
--             aguardando cliente/atrasou, serviço adicional contratado,
--             card movido no quadro.
--   Condições: serviço, etapa (pelo nome), tipo de cliente, status, coluna.
--   Ações: mover card no quadro, enviar aviso, definir responsável de etapa.
-- Segurança:
--   * Regras são da unidade (isolamento entre franquias) e só gestores editam.
--   * Ações rodam no servidor; uma falha de automação nunca impede a operação
--     original (fica registrada no histórico de execuções).
--   * Limite de encadeamento evita laços (automação disparando automação).
--   * Sem DELETE: regra excluída fica arquivada.
-- =============================================================================

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  trigger text not null check (trigger in ('project_created', 'project_status_changed', 'task_started', 'task_completed',
                                           'task_waiting_client', 'task_overdue', 'service_added', 'card_moved')),
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb check (jsonb_typeof(actions) = 'array'),
  active boolean not null default true,
  archived boolean not null default false,
  run_count int not null default 0,
  last_run_at timestamptz,
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automation_rules_lookup_idx on public.automation_rules (trigger, tenant_id) where active and not archived;

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.automation_rules (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  event text not null,
  project_id uuid references public.projects (id) on delete cascade,
  task_id uuid references public.project_tasks (id) on delete set null,
  ok boolean not null,
  results jsonb not null default '[]'::jsonb,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index automation_runs_tenant_idx on public.automation_runs (tenant_id, created_at desc);
create index automation_runs_rule_idx on public.automation_runs (rule_id, created_at desc);

-- Etapas já sinalizadas como atrasadas (evita repetir o gatilho a cada verificação)
create table private.automation_overdue_seen (
  task_id uuid not null references public.project_tasks (id) on delete cascade,
  planned_end_date date not null,
  seen_at timestamptz not null default now(),
  primary key (task_id, planned_end_date)
);

alter table public.automation_rules enable row level security;
alter table public.automation_runs enable row level security;
create policy automation_rules_select on public.automation_rules for select to authenticated
  using ((select private.is_manager()) and tenant_id = (select private.current_tenant_id()));
create policy automation_runs_select on public.automation_runs for select to authenticated
  using ((select private.is_manager()) and tenant_id = (select private.current_tenant_id()));
grant select on public.automation_rules, public.automation_runs to authenticated;

create trigger automation_rules_touch before update on public.automation_rules
  for each row execute function private.touch_updated_at();
create trigger automation_rules_audit after insert or update on public.automation_rules
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------
create or replace function private.step_key(p_name text) returns text
language sql immutable set search_path = ''
as $$
  select regexp_replace(translate(lower(trim(coalesce(p_name, ''))),
    'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn'), '\s+', ' ', 'g')
$$;

-- A regra da unidade vale para os projetos do quadro dela (a Franqueadora vê todos).
create or replace function private.automation_scope(p_tenant uuid, p public.projects) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.tenants t where t.id = p_tenant and t.type = 'franqueadora')
      or p_tenant in (p.delivery_tenant_id, p.commercial_tenant_id, p.origin_tenant_id)
$$;

-- Coloca um card numa coluna (usado pelo quadro e pelas automações).
create or replace function private.board_place(p_tenant uuid, p_project uuid, p_column uuid, p_before uuid, p_by uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_order numeric; v_prev numeric; v_old uuid; v_name text;
begin
  select name into v_name from public.project_board_columns where id = p_column and tenant_id = p_tenant and active;
  if v_name is null then raise exception 'Coluna não encontrada' using errcode = 'P0002'; end if;
  select column_id into v_old from public.project_board_cards where tenant_id = p_tenant and project_id = p_project;

  if p_before is not null then
    select sort_order into v_order from public.project_board_cards where tenant_id = p_tenant and project_id = p_before and column_id = p_column;
  end if;
  if v_order is null then
    v_order := coalesce((select max(sort_order) from public.project_board_cards where tenant_id = p_tenant and column_id = p_column and project_id <> p_project), 0) + 10;
  else
    select max(sort_order) into v_prev from public.project_board_cards
     where tenant_id = p_tenant and column_id = p_column and sort_order < v_order and project_id <> p_project;
    v_order := (coalesce(v_prev, v_order - 20) + v_order) / 2;
  end if;
  insert into public.project_board_cards (tenant_id, project_id, column_id, sort_order, moved_by, moved_at)
  values (p_tenant, p_project, p_column, v_order, p_by, now())
  on conflict (tenant_id, project_id) do update
    set column_id = excluded.column_id, sort_order = excluded.sort_order, moved_by = excluded.moved_by, moved_at = now();

  if v_old is distinct from p_column then
    begin
      perform private.automation_emit('card_moved', p_project,
        jsonb_build_object('column_id', p_column, 'column_name', v_name, 'board_tenant', p_tenant));
    exception when others then null;
    end;
  end if;
  return v_old is distinct from p_column;
end;
$$;

create or replace function private.board_move_card(p_project uuid, p_column uuid, p_before uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid := private.board_require_manager();
begin
  if not private.can_view_project(p_project) then raise exception 'Projeto não encontrado' using errcode = '42501'; end if;
  perform private.board_place(v_tenant, p_project, p_column, p_before, private.current_profile_id());
end;
$$;

-- -----------------------------------------------------------------------------
-- Condições
-- -----------------------------------------------------------------------------
create or replace function private.automation_match(r public.automation_rules, p public.projects, ctx jsonb)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare c jsonb := coalesce(r.conditions, '{}'::jsonb);
begin
  -- Card movido: só no quadro da própria unidade
  if r.trigger = 'card_moved' and (ctx ->> 'board_tenant')::uuid is distinct from r.tenant_id then return false; end if;

  if jsonb_array_length(coalesce(c -> 'client_types', '[]')) > 0
     and not (c -> 'client_types') ? p.client_type::text then return false; end if;

  if jsonb_array_length(coalesce(c -> 'services', '[]')) > 0 then
    if ctx ? 'service_code' then
      if not (c -> 'services') ? (ctx ->> 'service_code') then return false; end if;
    elsif not exists (select 1 from public.project_services x join public.services s on s.id = x.service_id
                      where x.project_id = p.id and x.active and (c -> 'services') ? s.code) then
      return false;
    end if;
  end if;

  if jsonb_array_length(coalesce(c -> 'steps', '[]')) > 0
     and not (c -> 'steps') ? coalesce(ctx ->> 'task_key', '') then return false; end if;

  if jsonb_array_length(coalesce(c -> 'to_status', '[]')) > 0
     and not (c -> 'to_status') ? coalesce(ctx ->> 'to', '') then return false; end if;

  if jsonb_array_length(coalesce(c -> 'columns', '[]')) > 0
     and not (c -> 'columns') ? coalesce(ctx ->> 'column_id', '') then return false; end if;

  return true;
end;
$$;

-- -----------------------------------------------------------------------------
-- Ações
-- -----------------------------------------------------------------------------
create or replace function private.automation_text(p_tpl text, p public.projects, ctx jsonb)
returns text
language sql stable security definer set search_path = ''
as $$
  select replace(replace(replace(replace(replace(replace(coalesce(p_tpl, ''),
    '{projeto}', p.name), '{codigo}', coalesce(p.code, '')),
    '{etapa}', coalesce(ctx ->> 'task_name', '')), '{servico}', coalesce(ctx ->> 'service_name', '')),
    '{cliente}', coalesce((select name from public.clients where id = p.client_id), '')),
    '{coluna}', coalesce(ctx ->> 'column_name', ''))
$$;

create or replace function private.automation_run_action(r public.automation_rules, act jsonb, p public.projects, ctx jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text := act ->> 'type';
  v_users uuid[] := '{}';
  v_rec text;
  v_title text; v_body text;
  v_user uuid; v_n int := 0;
  t record;
begin
  if v_type = 'move_card' then
    if private.board_place(r.tenant_id, p.id, (act ->> 'column_id')::uuid, null, null) then
      return 'Card movido para "' || (select name from public.project_board_columns where id = (act ->> 'column_id')::uuid) || '"';
    end if;
    return 'Card já estava na coluna';

  elsif v_type = 'notify' then
    v_title := nullif(trim(private.automation_text(act ->> 'title', p, ctx)), '');
    v_body := private.automation_text(act ->> 'message', p, ctx);
    for v_rec in select jsonb_array_elements_text(coalesce(act -> 'recipients', '[]')) loop
      if v_rec = 'project_lead' then
        v_users := v_users || array(select user_id from public.project_team where project_id = p.id and active and project_role = 'project_lead');
      elsif v_rec = 'task_responsible' then
        v_users := v_users || array(select responsible_user_id from public.project_tasks where id = (ctx ->> 'task_id')::uuid and responsible_user_id is not null);
      elsif v_rec = 'service_responsible' then
        v_users := v_users || array(select responsible_user_id from public.project_services
                                    where project_id = p.id and active and responsible_user_id is not null
                                      and (not ctx ? 'project_service_id' or id = (ctx ->> 'project_service_id')::uuid));
      elsif v_rec = 'project_team' then
        v_users := v_users || array(select user_id from public.project_team where project_id = p.id and active);
      elsif v_rec = 'unit_managers' then
        perform private.notify(r.tenant_id, 'automation', coalesce(v_title, r.name), v_body, 'projects', p.id,
          jsonb_build_object('rule_id', r.id), array['leader', 'unit_admin']::public.user_role[], null);
        v_n := v_n + 1;
      elsif v_rec like 'user:%' then
        v_users := v_users || substr(v_rec, 6)::uuid;
      end if;
    end loop;
    for v_user in select distinct u from unnest(v_users) u
                  join public.profiles pr on pr.id = u and pr.status = 'ativo' loop
      perform private.notify(coalesce(p.delivery_tenant_id, r.tenant_id), 'automation', coalesce(v_title, r.name), v_body,
        'projects', p.id, jsonb_build_object('rule_id', r.id, 'task_id', ctx ->> 'task_id'), null, v_user);
      v_n := v_n + 1;
    end loop;
    return case when v_n = 0 then 'Nenhum destinatário encontrado' else v_n || ' aviso(s) enviado(s)' end;

  elsif v_type = 'set_task_responsible' then
    perform private.engine_on();
    for t in
      select pt.id, pt.name, pt.responsible_user_id, ps.responsible_user_id as direct
      from public.project_tasks pt
      join public.project_schedule_tracks tr on tr.id = pt.schedule_track_id
      join public.project_services ps on ps.id = tr.project_service_id
      join public.services s on s.id = ps.service_id
      where pt.project_id = p.id and pt.status not in ('completed', 'cancelled')
        and private.step_key(pt.name) = private.step_key(act ->> 'step')
        and (nullif(act ->> 'service', '') is null or s.code = act ->> 'service')
    loop
      v_user := case when act ->> 'assignee' = 'service_responsible' then t.direct
                     when act ->> 'assignee' like 'user:%' then substr(act ->> 'assignee', 6)::uuid end;
      if v_user is null or v_user is not distinct from t.responsible_user_id then continue; end if;
      if not exists (select 1 from public.profiles pr where pr.id = v_user and pr.status = 'ativo'
                       and pr.role in ('collaborator', 'leader', 'unit_admin') and pr.tenant_id = p.delivery_tenant_id) then
        raise exception 'Responsável inválido para a unidade executora';
      end if;
      update public.project_tasks set responsible_user_id = v_user where id = t.id;
      perform private.ensure_project_member(p.id, v_user);
      insert into public.task_changes (project_id, task_id, change_type, before, after, reason, changed_by)
      values (p.id, t.id, 'responsible', jsonb_build_object('responsible_user_id', t.responsible_user_id),
              jsonb_build_object('responsible_user_id', v_user), 'Automação: ' || r.name, null);
      perform private.notify(p.delivery_tenant_id, 'task_assigned', 'Nova etapa sob sua responsabilidade',
        t.name || ' · ' || p.name, 'project_tasks', t.id, '{}'::jsonb, null, v_user);
      v_n := v_n + 1;
    end loop;
    return case when v_n = 0 then 'Nenhuma etapa aberta para alterar' else v_n || ' etapa(s) com novo responsável' end;
  end if;

  raise exception 'Ação desconhecida: %', v_type;
end;
$$;

-- -----------------------------------------------------------------------------
-- Disparo
-- -----------------------------------------------------------------------------
create or replace function private.automation_emit(p_event text, p_project uuid, p_ctx jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_depth int := coalesce(nullif(current_setting('youcon.automation_depth', true), ''), '0')::int;
  p public.projects;
  r public.automation_rules;
  act jsonb;
  v_results jsonb;
  v_ok boolean;
  v_runs int := 0;
begin
  if v_depth >= 3 then return 0; end if;
  if not exists (select 1 from public.automation_rules where trigger = p_event and active and not archived) then return 0; end if;
  select * into p from public.projects where id = p_project;
  if p.id is null then return 0; end if;

  for r in
    select * from public.automation_rules ar
    where ar.trigger = p_event and ar.active and not ar.archived and private.automation_scope(ar.tenant_id, p)
    order by ar.created_at
  loop
    if not private.automation_match(r, p, p_ctx) then continue; end if;
    perform set_config('youcon.automation_depth', (v_depth + 1)::text, true);
    v_results := '[]'::jsonb; v_ok := true;
    for act in select * from jsonb_array_elements(r.actions) loop
      begin
        v_results := v_results || jsonb_build_object('type', act ->> 'type', 'ok', true,
                                                     'message', private.automation_run_action(r, act, p, p_ctx));
      exception when others then
        v_ok := false;
        v_results := v_results || jsonb_build_object('type', act ->> 'type', 'ok', false, 'message', sqlerrm);
      end;
    end loop;
    perform set_config('youcon.automation_depth', v_depth::text, true);
    insert into public.automation_runs (rule_id, tenant_id, event, project_id, task_id, ok, results, context)
    values (r.id, r.tenant_id, p_event, p.id, (p_ctx ->> 'task_id')::uuid, v_ok, v_results, coalesce(p_ctx, '{}'::jsonb));
    update public.automation_rules set run_count = run_count + 1, last_run_at = now() where id = r.id;
    v_runs := v_runs + 1;
  end loop;
  return v_runs;
end;
$$;

-- Contexto de uma etapa (serviço, nome normalizado)
create or replace function private.automation_task_ctx(p_task uuid, p_from text, p_to text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('task_id', t.id, 'task_name', t.name, 'task_key', private.step_key(t.name),
    'project_service_id', ps.id, 'service_code', s.code, 'service_name', s.name, 'from', p_from, 'to', p_to)
  from public.project_tasks t
  join public.project_schedule_tracks tr on tr.id = t.schedule_track_id
  join public.project_services ps on ps.id = tr.project_service_id
  join public.services s on s.id = ps.service_id
  where t.id = p_task
$$;

-- Gatilhos nas tabelas (falha de automação nunca quebra a operação)
create or replace function private.automation_on_task_status() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_event text;
begin
  if new.status is not distinct from old.status then return null; end if;
  v_event := case new.status when 'in_progress' then 'task_started' when 'completed' then 'task_completed'
                             when 'waiting_client' then 'task_waiting_client' end;
  if v_event is null then return null; end if;
  begin
    perform private.automation_emit(v_event, new.project_id, private.automation_task_ctx(new.id, old.status::text, new.status::text));
  exception when others then null;
  end;
  return null;
end;
$$;
create trigger project_tasks_automation after update of status on public.project_tasks
  for each row execute function private.automation_on_task_status();

create or replace function private.automation_on_project() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform private.automation_emit('project_created', new.id, jsonb_build_object('to', new.status));
    elsif new.status is distinct from old.status then
      perform private.automation_emit('project_status_changed', new.id, jsonb_build_object('from', old.status, 'to', new.status));
    end if;
  exception when others then null;
  end;
  return null;
end;
$$;
-- Entrada do projeto: adiada para o fim da transação (serviços já gravados).
create constraint trigger projects_automation_created after insert on public.projects
  deferrable initially deferred for each row execute function private.automation_on_project();
create trigger projects_automation_status after update of status on public.projects
  for each row execute function private.automation_on_project();

create or replace function private.automation_on_service() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'pending_review' then
    begin
      perform private.automation_emit('service_added', new.project_id,
        (select jsonb_build_object('project_service_id', new.id, 'service_code', s.code, 'service_name', s.name)
         from public.services s where s.id = new.service_id));
    exception when others then null;
    end;
  end if;
  return null;
end;
$$;
create trigger project_services_automation after insert on public.project_services
  for each row execute function private.automation_on_service();

-- Etapas que passaram a estar atrasadas (rodado periodicamente)
create or replace function private.automation_scan_overdue() returns int
language plpgsql security definer set search_path = ''
as $$
declare t record; v_n int := 0;
begin
  for t in
    select pt.id, pt.project_id, pt.planned_end_date, pt.status
    from public.project_tasks pt join public.projects p on p.id = pt.project_id
    where p.status = 'in_progress' and pt.status not in ('completed', 'cancelled')
      and pt.planned_end_date < current_date
      and not exists (select 1 from private.automation_overdue_seen s where s.task_id = pt.id and s.planned_end_date = pt.planned_end_date)
  loop
    insert into private.automation_overdue_seen (task_id, planned_end_date) values (t.id, t.planned_end_date) on conflict do nothing;
    begin
      perform private.automation_emit('task_overdue', t.project_id, private.automation_task_ctx(t.id, t.status::text, 'overdue'));
    exception when others then null;
    end;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Gestão das regras
-- -----------------------------------------------------------------------------
create or replace function private.automation_save(p_id uuid, p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := private.current_tenant_id();
  v_trigger text := p_payload ->> 'trigger';
  v_actions jsonb := coalesce(p_payload -> 'actions', '[]'::jsonb);
  v_cond jsonb := coalesce(p_payload -> 'conditions', '{}'::jsonb);
  act jsonb; v_rec text; v_id uuid;
begin
  if not private.is_manager() or v_tenant is null then
    raise exception 'Somente gestores configuram automações' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_payload ->> 'name', ''))) = 0 then raise exception 'Dê um nome para a automação' using errcode = '23514'; end if;
  if v_trigger not in ('project_created', 'project_status_changed', 'task_started', 'task_completed',
                       'task_waiting_client', 'task_overdue', 'service_added', 'card_moved') then
    raise exception 'Escolha o gatilho da automação' using errcode = '23514';
  end if;
  if jsonb_typeof(v_actions) <> 'array' or jsonb_array_length(v_actions) = 0 then
    raise exception 'Adicione ao menos uma ação' using errcode = '23514';
  end if;
  if jsonb_typeof(v_cond) <> 'object' then raise exception 'Condições inválidas' using errcode = '22023'; end if;

  for act in select * from jsonb_array_elements(v_actions) loop
    if act ->> 'type' = 'move_card' then
      if not exists (select 1 from public.project_board_columns where id = (act ->> 'column_id')::uuid and tenant_id = v_tenant and active) then
        raise exception 'Escolha a coluna do quadro para onde o card vai' using errcode = '23514';
      end if;
    elsif act ->> 'type' = 'notify' then
      if jsonb_array_length(coalesce(act -> 'recipients', '[]')) = 0 then
        raise exception 'Escolha quem recebe o aviso' using errcode = '23514';
      end if;
      if length(trim(coalesce(act ->> 'title', ''))) = 0 then raise exception 'Escreva o título do aviso' using errcode = '23514'; end if;
      for v_rec in select jsonb_array_elements_text(act -> 'recipients') loop
        if v_rec like 'user:%' and not exists (select 1 from public.profiles where id = substr(v_rec, 6)::uuid and tenant_id = v_tenant) then
          raise exception 'A pessoa escolhida não pertence à sua unidade' using errcode = '23514';
        end if;
      end loop;
    elsif act ->> 'type' = 'set_task_responsible' then
      if length(trim(coalesce(act ->> 'step', ''))) = 0 then raise exception 'Escolha a etapa que recebe o responsável' using errcode = '23514'; end if;
      if coalesce(act ->> 'assignee', '') <> 'service_responsible'
         and not (act ->> 'assignee' like 'user:%' and exists (select 1 from public.profiles where id = substr(act ->> 'assignee', 6)::uuid and tenant_id = v_tenant)) then
        raise exception 'Escolha o responsável da etapa' using errcode = '23514';
      end if;
    else
      raise exception 'Ação inválida' using errcode = '23514';
    end if;
  end loop;

  if p_id is null then
    insert into public.automation_rules (tenant_id, name, trigger, conditions, actions, active, created_by, updated_by)
    values (v_tenant, trim(p_payload ->> 'name'), v_trigger, v_cond, v_actions, coalesce((p_payload ->> 'active')::boolean, true),
            private.current_profile_id(), private.current_profile_id())
    returning id into v_id;
  else
    update public.automation_rules
       set name = trim(p_payload ->> 'name'), trigger = v_trigger, conditions = v_cond, actions = v_actions,
           active = coalesce((p_payload ->> 'active')::boolean, active), updated_by = private.current_profile_id()
     where id = p_id and tenant_id = v_tenant and not archived
    returning id into v_id;
    if v_id is null then raise exception 'Automação não encontrada' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function private.automation_set_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Somente gestores configuram automações' using errcode = '42501'; end if;
  update public.automation_rules set active = p_active, updated_by = private.current_profile_id()
   where id = p_id and tenant_id = private.current_tenant_id() and not archived;
  if not found then raise exception 'Automação não encontrada' using errcode = 'P0002'; end if;
end;
$$;

create or replace function private.automation_archive(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_manager() then raise exception 'Somente gestores configuram automações' using errcode = '42501'; end if;
  update public.automation_rules set archived = true, active = false, updated_by = private.current_profile_id()
   where id = p_id and tenant_id = private.current_tenant_id() and not archived;
  if not found then raise exception 'Automação não encontrada' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.automation_save(p_id uuid, p_payload jsonb) returns uuid
language sql security invoker set search_path = '' as $$ select private.automation_save(p_id, p_payload) $$;
create or replace function public.automation_set_active(p_id uuid, p_active boolean) returns void
language sql security invoker set search_path = '' as $$ select private.automation_set_active(p_id, p_active) $$;
create or replace function public.automation_archive(p_id uuid) returns void
language sql security invoker set search_path = '' as $$ select private.automation_archive(p_id) $$;

revoke all on function public.automation_save(uuid, jsonb), public.automation_set_active(uuid, boolean), public.automation_archive(uuid) from public, anon;
grant execute on function public.automation_save(uuid, jsonb), public.automation_set_active(uuid, boolean), public.automation_archive(uuid) to authenticated;
revoke all on function private.automation_save(uuid, jsonb), private.automation_set_active(uuid, boolean), private.automation_archive(uuid),
  private.automation_emit(text, uuid, jsonb), private.automation_run_action(public.automation_rules, jsonb, public.projects, jsonb),
  private.automation_match(public.automation_rules, public.projects, jsonb), private.automation_text(text, public.projects, jsonb),
  private.automation_scope(uuid, public.projects), private.automation_task_ctx(uuid, text, text), private.automation_scan_overdue(),
  private.board_place(uuid, uuid, uuid, uuid, uuid), private.automation_on_task_status(), private.automation_on_project(),
  private.automation_on_service()
  from public, anon, authenticated;
grant execute on function private.automation_save(uuid, jsonb), private.automation_set_active(uuid, boolean), private.automation_archive(uuid)
  to authenticated, service_role;
grant execute on function private.automation_scan_overdue(), private.automation_emit(text, uuid, jsonb) to service_role;

-- Atrasos já existentes não disparam regras novas
select private.automation_scan_overdue();
