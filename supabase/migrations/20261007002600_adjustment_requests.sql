-- =============================================================================
-- 0026 · Solicitação de ajuste entre setores
--
-- Ex.: a equipe do Estrutural percebe que a Arquitetura precisa ajustar algo.
--   1. Qualquer pessoa da equipe que vê o projeto solicita o ajuste numa etapa
--      (concluída ou em andamento) de outro serviço, com a complexidade e o que
--      precisa ser feito.
--   2. O líder da área do serviço requisitado (Arquitetura, Engenharia ou
--      Aprovação) recebe o aviso e aprova ou recusa. Ao aprovar, confirma o prazo
--      (sugerido pela complexidade) e escolhe o colaborador que executa.
--   3. Aprovado: etapa concluída é reaberta pelo prazo do ajuste; etapa em
--      andamento ganha os dias a mais. O cronograma do contrato inteiro anda
--      (mesma regra de atraso/reabertura) e o colaborador é avisado.
--
-- Prazos por complexidade: tabela configurável (ADM Global), valores iniciais
-- sugeridos e editáveis em Serviços e Cronogramas.
-- =============================================================================

create table public.adjustment_complexities (
  code         text primary key check (code in ('simple', 'medium', 'complex')),
  label        text not null check (length(trim(label)) between 2 and 60),
  default_days int  not null check (default_days between 1 and 365),
  description  text,
  sort_order   int  not null default 0,
  updated_at   timestamptz not null default now()
);
create trigger adjustment_complexities_touch before update on public.adjustment_complexities
  for each row execute function private.touch_updated_at();
create trigger adjustment_complexities_audit after insert or update on public.adjustment_complexities
  for each row execute function private.audit_row();
alter table public.adjustment_complexities enable row level security;
create policy adjustment_complexities_select on public.adjustment_complexities for select to authenticated
  using (private.is_staff());
create policy adjustment_complexities_update on public.adjustment_complexities for update to authenticated
  using (private.is_global_admin()) with check (private.is_global_admin());
revoke all on public.adjustment_complexities from anon;
grant select, update on public.adjustment_complexities to authenticated;

insert into public.adjustment_complexities (code, label, default_days, description, sort_order) values
  ('simple',  'Alteração simples',  3,  'Ajuste pontual, sem impacto em outras partes do projeto.', 1),
  ('medium',  'Alteração média',    7,  'Ajuste que envolve mais de um ambiente ou prancha.', 2),
  ('complex', 'Alteração complexa', 15, 'Ajuste que muda a concepção ou exige nova compatibilização.', 3)
on conflict do nothing;

insert into public.schedule_change_reasons (label, client_visible, is_other, sort_order)
values ('Ajuste interno solicitado entre setores', false, false, 92)
on conflict do nothing;

create table public.adjustment_requests (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects (id) on delete cascade,
  task_id                 uuid not null references public.project_tasks (id) on delete cascade,
  target_project_service_id uuid not null references public.project_services (id) on delete cascade,
  from_project_service_id uuid references public.project_services (id) on delete set null,
  requested_by            uuid not null references public.profiles (id),
  complexity              text not null references public.adjustment_complexities (code),
  requested_days          int  not null check (requested_days between 1 and 2000),
  description             text not null check (length(trim(description)) >= 5),
  status                  text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by              uuid references public.profiles (id),
  decided_at              timestamptz,
  decision_note           text,
  approved_days           int,
  assignee_id             uuid references public.profiles (id),
  result                  jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index adjustment_requests_project_idx on public.adjustment_requests (project_id, created_at desc);
create unique index adjustment_requests_one_pending_uidx on public.adjustment_requests (task_id) where status = 'pending';
create trigger adjustment_requests_touch before update on public.adjustment_requests
  for each row execute function private.touch_updated_at();
create trigger adjustment_requests_audit after insert or update on public.adjustment_requests
  for each row execute function private.audit_row();
alter table public.adjustment_requests enable row level security;
create policy adjustment_requests_select on public.adjustment_requests for select to authenticated
  using (private.is_staff() and private.can_view_project(project_id));
revoke all on public.adjustment_requests from anon;
grant select on public.adjustment_requests to authenticated;

-- Quem aprova: líder(es) da área do serviço requisitado; sem líder definido, quem gerencia o projeto.
create or replace function private.adjustment_approvers(p_request uuid) returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select case when coalesce(array_length(l.ids, 1), 0) > 0 then l.ids
              else array(select pr.id from public.profiles pr, public.projects p
                         where p.id = r.project_id and pr.status = 'ativo'
                           and (pr.role = 'global_admin' or (pr.role in ('unit_admin', 'leader') and pr.tenant_id = p.delivery_tenant_id))) end
  from public.adjustment_requests r,
       lateral (select private.project_leaders(r.project_id, r.target_project_service_id) as ids) l
  where r.id = p_request
$$;

-- Lista do projeto (com nomes e se eu posso decidir).
create or replace function private.project_adjustments(p_project uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by (x ->> 'status') = 'pending' desc, x ->> 'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', r.id, 'project_id', r.project_id, 'project_name', p.name, 'project_code', p.code,
      'task_id', r.task_id, 'task_name', t.name, 'task_status', t.status,
      'target_service', ts.name, 'from_service', fs.name,
      'complexity', r.complexity, 'complexity_label', c.label, 'requested_days', r.requested_days,
      'description', r.description, 'status', r.status,
      'requested_by', jsonb_build_object('id', rq.id, 'name', rq.name),
      'decided_by', case when dc.id is not null then jsonb_build_object('id', dc.id, 'name', dc.name) end,
      'decided_at', r.decided_at, 'decision_note', r.decision_note, 'approved_days', r.approved_days,
      'assignee', case when asg.id is not null then jsonb_build_object('id', asg.id, 'name', asg.name) end,
      'result', r.result, 'created_at', r.created_at,
      'approvers', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name)), '[]'::jsonb)
                      from public.profiles a where a.id = any (private.adjustment_approvers(r.id))),
      'can_decide', r.status = 'pending' and private.current_profile_id() = any (private.adjustment_approvers(r.id)),
      'can_cancel', r.status = 'pending' and r.requested_by = private.current_profile_id()
    ) as x
    from public.adjustment_requests r
    join public.projects p on p.id = r.project_id
    join public.project_tasks t on t.id = r.task_id
    join public.project_services tps on tps.id = r.target_project_service_id
    join public.services ts on ts.id = tps.service_id
    left join public.project_services fps on fps.id = r.from_project_service_id
    left join public.services fs on fs.id = fps.service_id
    join public.adjustment_complexities c on c.code = r.complexity
    join public.profiles rq on rq.id = r.requested_by
    left join public.profiles dc on dc.id = r.decided_by
    left join public.profiles asg on asg.id = r.assignee_id
    where (p_project is null or r.project_id = p_project)
      and private.is_staff() and private.can_view_project(r.project_id)
  ) q
$$;

-- Pendentes que EU devo aprovar (para a tela inicial do líder).
create or replace function private.my_pending_adjustments() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x order by x ->> 'created_at'), '[]'::jsonb)
  from jsonb_array_elements(private.project_adjustments(null)) x
  where (x ->> 'can_decide')::boolean
$$;

create or replace function private.adjustment_create(p_task uuid, p_complexity text, p_description text,
  p_days int default null, p_from_service uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  t public.project_tasks;
  p public.projects;
  c public.adjustment_complexities;
  v_ps uuid;
  v_id uuid;
  v_days int;
  v_svc text;
  v_user uuid;
begin
  select * into t from public.project_tasks where id = p_task;
  if t.id is null or not private.is_staff() or not private.can_view_project(t.project_id) then
    raise exception 'Etapa não encontrada' using errcode = 'P0002';
  end if;
  if t.status not in ('completed', 'in_progress', 'waiting_client', 'waiting_third_party', 'waiting_dependency') then
    raise exception 'Só é possível pedir ajuste em etapa concluída ou em andamento' using errcode = '23514';
  end if;
  if t.duration_type not in ('fixed', 'external') then
    raise exception 'Esta etapa não tem duração própria; peça o ajuste na etapa de produção do serviço' using errcode = '23514';
  end if;
  select * into c from public.adjustment_complexities where code = p_complexity;
  if c.code is null then raise exception 'Escolha a complexidade do ajuste' using errcode = '23514'; end if;
  if length(trim(coalesce(p_description, ''))) < 5 then
    raise exception 'Descreva o que precisa ser ajustado' using errcode = '23514';
  end if;
  v_days := coalesce(p_days, c.default_days);
  if v_days < 1 or v_days > 2000 then raise exception 'Prazo do ajuste: de 1 a 2000 dias úteis' using errcode = '23514'; end if;
  if exists (select 1 from public.adjustment_requests where task_id = t.id and status = 'pending') then
    raise exception 'Já existe um pedido de ajuste aguardando aprovação para esta etapa' using errcode = '23505';
  end if;

  select tr.project_service_id into v_ps from public.project_schedule_tracks tr where tr.id = t.schedule_track_id;
  if p_from_service is not null and not exists (select 1 from public.project_services where id = p_from_service and project_id = t.project_id) then
    raise exception 'Setor solicitante inválido' using errcode = '23514';
  end if;
  select * into p from public.projects where id = t.project_id;

  insert into public.adjustment_requests (project_id, task_id, target_project_service_id, from_project_service_id, requested_by,
                                          complexity, requested_days, description)
  values (t.project_id, t.id, v_ps, p_from_service, private.current_profile_id(), c.code, v_days, trim(p_description))
  returning id into v_id;

  select s.name into v_svc from public.project_services ps join public.services s on s.id = ps.service_id where ps.id = v_ps;
  for v_user in select unnest(private.adjustment_approvers(v_id)) loop
    perform private.notify(p.delivery_tenant_id, 'adjustment_request', 'Ajuste aguardando sua aprovação',
      v_svc || ' · ' || t.name || ' · ' || p.name || ' (' || c.label || ')', 'projects', p.id,
      jsonb_build_object('adjustment_id', v_id, 'task_id', t.id), null, v_user);
  end loop;
  return v_id;
end;
$$;

create or replace function private.adjustment_decide(p_request uuid, p_approve boolean, p_note text default null,
  p_days int default null, p_assignee uuid default null, p_start date default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r public.adjustment_requests;
  t public.project_tasks;
  p public.projects;
  v_reason uuid;
  v_days int;
  v_text text;
  v_res jsonb;
begin
  select * into r from public.adjustment_requests where id = p_request for update;
  if r.id is null or not private.can_view_project(r.project_id) then
    raise exception 'Pedido de ajuste não encontrado' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then raise exception 'Este pedido já foi decidido' using errcode = '23514'; end if;
  if not (private.current_profile_id() = any (private.adjustment_approvers(r.id))) then
    raise exception 'Só o líder do setor requisitado aprova este ajuste' using errcode = '42501';
  end if;
  select * into p from public.projects where id = r.project_id;

  if not p_approve then
    if length(trim(coalesce(p_note, ''))) < 3 then
      raise exception 'Explique por que o ajuste foi recusado' using errcode = '23514';
    end if;
    update public.adjustment_requests set status = 'rejected', decided_by = private.current_profile_id(),
           decided_at = now(), decision_note = trim(p_note) where id = r.id;
    perform private.notify(p.delivery_tenant_id, 'adjustment_request', 'Pedido de ajuste recusado',
      p.name || ' · ' || trim(p_note), 'projects', p.id, jsonb_build_object('adjustment_id', r.id), null, r.requested_by);
    return jsonb_build_object('status', 'rejected');
  end if;

  v_days := coalesce(p_days, r.requested_days);
  if p_assignee is null then raise exception 'Escolha o colaborador que vai executar o ajuste' using errcode = '23514'; end if;
  select id into v_reason from public.schedule_change_reasons where label = 'Ajuste interno solicitado entre setores';
  if v_reason is null then
    select id into v_reason from public.schedule_change_reasons where active and is_other limit 1;
  end if;
  v_text := 'Pedido de ajuste: ' || r.description;

  -- Responsável primeiro (a reabertura avisa o responsável da etapa).
  perform private.set_task_responsible(r.task_id, p_assignee);
  select * into t from public.project_tasks where id = r.task_id;
  if t.status = 'completed' then
    v_res := private.reopen_apply(t.id, p_start, v_days, v_reason, v_text);
    v_res := v_res || jsonb_build_object('mode', 'reopened');
  else
    v_res := private.reschedule_task_with_reason(t.id, null, coalesce(t.planned_duration_days, 0) + v_days, v_reason, v_text);
    v_res := v_res || jsonb_build_object('mode', 'extended');
  end if;

  update public.adjustment_requests
     set status = 'approved', decided_by = private.current_profile_id(), decided_at = now(),
         decision_note = nullif(trim(coalesce(p_note, '')), ''), approved_days = v_days, assignee_id = p_assignee,
         result = v_res
   where id = r.id;
  perform private.notify(p.delivery_tenant_id, 'adjustment_request', 'Pedido de ajuste aprovado',
    t.name || ' · ' || p.name || ' · ' || v_days || ' dias úteis', 'projects', p.id,
    jsonb_build_object('adjustment_id', r.id), null, r.requested_by);
  return v_res || jsonb_build_object('status', 'approved');
end;
$$;

create or replace function private.adjustment_cancel(p_request uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.adjustment_requests set status = 'cancelled', decided_at = now()
   where id = p_request and status = 'pending' and requested_by = private.current_profile_id();
  if not found then raise exception 'Pedido não encontrado ou já decidido' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.project_adjustments(p_project uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.project_adjustments(p_project) $$;
create or replace function public.my_pending_adjustments() returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.my_pending_adjustments() $$;
create or replace function public.adjustment_create(p_task uuid, p_complexity text, p_description text,
  p_days int default null, p_from_service uuid default null) returns uuid
language sql security invoker set search_path = '' as $$ select private.adjustment_create(p_task, p_complexity, p_description, p_days, p_from_service) $$;
create or replace function public.adjustment_decide(p_request uuid, p_approve boolean, p_note text default null,
  p_days int default null, p_assignee uuid default null, p_start date default null) returns jsonb
language sql security invoker set search_path = '' as $$ select private.adjustment_decide(p_request, p_approve, p_note, p_days, p_assignee, p_start) $$;
create or replace function public.adjustment_cancel(p_request uuid) returns void
language sql security invoker set search_path = '' as $$ select private.adjustment_cancel(p_request) $$;

revoke all on function private.adjustment_approvers(uuid), private.project_adjustments(uuid), private.my_pending_adjustments(),
  private.adjustment_create(uuid, text, text, int, uuid), private.adjustment_decide(uuid, boolean, text, int, uuid, date),
  private.adjustment_cancel(uuid) from public, anon;
grant execute on function private.adjustment_approvers(uuid), private.project_adjustments(uuid), private.my_pending_adjustments(),
  private.adjustment_create(uuid, text, text, int, uuid), private.adjustment_decide(uuid, boolean, text, int, uuid, date),
  private.adjustment_cancel(uuid) to authenticated;
revoke all on function public.project_adjustments(uuid), public.my_pending_adjustments(),
  public.adjustment_create(uuid, text, text, int, uuid), public.adjustment_decide(uuid, boolean, text, int, uuid, date),
  public.adjustment_cancel(uuid) from public, anon;
grant execute on function public.project_adjustments(uuid), public.my_pending_adjustments(),
  public.adjustment_create(uuid, text, text, int, uuid), public.adjustment_decide(uuid, boolean, text, int, uuid, date),
  public.adjustment_cancel(uuid) to authenticated;
