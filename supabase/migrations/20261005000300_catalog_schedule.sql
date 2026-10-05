-- =============================================================================
-- Portal de Projetos YouCon — Migration 0003: Catálogo de serviços e motor de
-- cronograma (modelo + RLS + calendário de dias úteis).
--
-- Estrutura: Cliente → Projeto → Serviços contratados → Trilhas → Etapas.
-- Cada serviço tem sua trilha. Templates são versionados: projetos guardam o
-- template_id da versão usada e nunca mudam quando o padrão YouCon muda.
-- =============================================================================

create type public.duration_type         as enum ('fixed', 'dependent', 'external', 'ongoing');
create type public.template_status       as enum ('draft', 'published', 'archived');
create type public.project_service_status as enum ('pending_review', 'active', 'completed', 'cancelled');
create type public.track_status          as enum ('no_template', 'awaiting_area', 'planned', 'in_progress', 'completed', 'cancelled');
create type public.task_status           as enum ('not_started', 'waiting_dependency', 'ready', 'in_progress',
                                                  'waiting_client', 'waiting_third_party', 'completed', 'overdue', 'cancelled');
create type public.dependency_type       as enum ('finish_to_start', 'start_to_start', 'finish_to_finish');

-- -----------------------------------------------------------------------------
-- Catálogo
-- -----------------------------------------------------------------------------
create table public.service_families (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique check (code ~ '^[a-z0-9_]+$'),
  name                 text not null,
  default_project_role text references public.project_roles(code),  -- função de equipe sugerida
  sort_order           int not null default 0,
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger service_families_touch before update on public.service_families
  for each row execute function private.touch_updated_at();

create table public.services (
  id                    uuid primary key default gen_random_uuid(),
  family_id             uuid not null references public.service_families(id) on delete restrict,
  code                  text not null unique check (code ~ '^[a-z0-9_]+$'),
  name                  text not null,
  description           text,
  available_for_b2c     boolean not null default true,
  available_for_b2b     boolean not null default true,
  has_schedule_template boolean not null default false,  -- mantido por trigger a partir dos templates publicados
  requires_area_rule    boolean not null default false,
  sort_order            int not null default 0,
  active                boolean not null default true,
  aliases               text[] not null default '{}',     -- nomes alternativos vindos do CRM
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint services_availability_chk check (available_for_b2c or available_for_b2b)
);
create index services_family_idx on public.services (family_id, sort_order);
create trigger services_touch before update on public.services
  for each row execute function private.touch_updated_at();
create trigger services_audit after insert or update or delete on public.services
  for each row execute function private.audit_row();

create table public.service_packages (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z0-9_]+$'),
  name        text not null,
  description text,
  aliases     text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger service_packages_touch before update on public.service_packages
  for each row execute function private.touch_updated_at();

create table public.package_services (
  package_id uuid not null references public.service_packages(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete restrict,
  primary key (package_id, service_id)
);

-- -----------------------------------------------------------------------------
-- Templates versionados
-- -----------------------------------------------------------------------------
create table public.schedule_templates (
  id           uuid primary key default gen_random_uuid(),
  service_id   uuid not null references public.services(id) on delete restrict,
  name         text not null,
  version      int not null check (version >= 1),
  client_type  public.client_type,            -- null = vale para B2C e B2B
  area_min     numeric(10,2),                 -- exclusivo: área > area_min
  area_max     numeric(10,2),                 -- inclusivo: área <= area_max
  status       public.template_status not null default 'draft',
  active       boolean not null default false, -- versão vigente da variante
  notes        text,
  created_by   uuid references public.profiles(id) on delete set null,
  published_by uuid references public.profiles(id) on delete set null,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint schedule_templates_area_chk check (area_min is null or area_max is null or area_min < area_max),
  constraint schedule_templates_active_chk check (not active or status = 'published')
);
-- Variante = (serviço, tipo de cliente, faixa de área). Uma versão vigente por variante.
create unique index schedule_templates_version_uidx
  on public.schedule_templates (service_id, client_type, area_min, area_max, version) nulls not distinct;
create unique index schedule_templates_active_uidx
  on public.schedule_templates (service_id, client_type, area_min, area_max) nulls not distinct where active;
create trigger schedule_templates_touch before update on public.schedule_templates
  for each row execute function private.touch_updated_at();
create trigger schedule_templates_audit after insert or update or delete on public.schedule_templates
  for each row execute function private.audit_row();

create table public.template_tasks (
  id                       uuid primary key default gen_random_uuid(),
  template_id              uuid not null references public.schedule_templates(id) on delete cascade,
  code                     text not null check (code ~ '^[a-z0-9_]+$'),  -- referência estável entre versões
  name                     text not null,
  description              text,
  sort_order               int not null,
  default_duration_days    int check (default_duration_days is null or default_duration_days > 0), -- null = a definir
  duration_type            public.duration_type not null default 'fixed',
  include_if_service_codes text[],             -- etapa condicional: só entra se algum destes serviços estiver contratado
  client_visible           boolean not null default true,
  active                   boolean not null default true,
  unique (template_id, code),
  -- fixed sem duração = "duração a definir" (permitido, não inventamos prazo)
  constraint template_tasks_duration_chk check (duration_type = 'fixed' or default_duration_days is null)
);
create index template_tasks_template_idx on public.template_tasks (template_id, sort_order);

-- Dependências do template: dentro do template (predecessor_task_id) ou entre
-- serviços (predecessor_service_code + predecessor_task_code), resolvidas na
-- geração do cronograma e ignoradas quando o serviço predecessor não foi contratado.
create table public.template_task_dependencies (
  id                       uuid primary key default gen_random_uuid(),
  template_task_id         uuid not null references public.template_tasks(id) on delete cascade,
  predecessor_task_id      uuid references public.template_tasks(id) on delete cascade,
  predecessor_service_code text references public.services(code) on update cascade,
  predecessor_task_code    text,
  dependency_type          public.dependency_type not null default 'finish_to_start',
  lag_days                 int not null default 0,
  optional_if_missing      boolean not null default true,
  constraint template_dep_target_chk check (
    (predecessor_task_id is not null and predecessor_service_code is null and predecessor_task_code is null) or
    (predecessor_task_id is null and predecessor_service_code is not null and predecessor_task_code is not null)
  ),
  constraint template_dep_self_chk check (predecessor_task_id is distinct from template_task_id)
);
create index template_task_dependencies_task_idx on public.template_task_dependencies (template_task_id);

-- Template publicado é imutável (alterar padrão = nova versão).
create or replace function private.guard_published_template_tasks()
returns trigger language plpgsql set search_path = ''
as $$
declare
  v_template uuid := coalesce(new.template_id, old.template_id);
begin
  if exists (select 1 from public.schedule_templates where id = v_template and status <> 'draft') then
    raise exception 'Template publicado é imutável. Crie uma nova versão para alterar o padrão YouCon.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger template_tasks_guard before insert or update or delete on public.template_tasks
  for each row execute function private.guard_published_template_tasks();

create or replace function private.guard_published_template_deps()
returns trigger language plpgsql set search_path = ''
as $$
declare
  v_task uuid := coalesce(new.template_task_id, old.template_task_id);
begin
  if exists (select 1 from public.template_tasks tt
             join public.schedule_templates st on st.id = tt.template_id
             where tt.id = v_task and st.status <> 'draft') then
    raise exception 'Template publicado é imutável. Crie uma nova versão para alterar o padrão YouCon.'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger template_deps_guard before insert or update or delete on public.template_task_dependencies
  for each row execute function private.guard_published_template_deps();

-- has_schedule_template reflete se há template vigente.
create or replace function private.sync_service_has_template()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_service uuid := coalesce(new.service_id, old.service_id);
begin
  update public.services s
     set has_schedule_template = exists (select 1 from public.schedule_templates t
                                         where t.service_id = s.id and t.active)
   where s.id = v_service;
  return null;
end;
$$;
create trigger schedule_templates_sync_service after insert or update or delete on public.schedule_templates
  for each row execute function private.sync_service_has_template();

-- -----------------------------------------------------------------------------
-- Calendário de dias úteis
-- -----------------------------------------------------------------------------
create table public.business_calendars (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references public.tenants(id) on delete cascade,  -- null = calendário global YouCon
  name       text not null,
  workdays   int[] not null default '{1,2,3,4,5}' check (workdays <@ '{1,2,3,4,5,6,7}'), -- ISO: 1=seg … 7=dom
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index business_calendars_default_uidx
  on public.business_calendars (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_default;
create trigger business_calendars_touch before update on public.business_calendars
  for each row execute function private.touch_updated_at();

create table public.holidays (
  id          uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.business_calendars(id) on delete cascade,
  date        date not null,
  name        text not null,
  recurring   boolean not null default false,  -- repete todo ano (dia/mês)
  created_at  timestamptz not null default now(),
  unique (calendar_id, date)
);

-- Calendário efetivo: o padrão do tenant, senão o global.
create or replace function private.calendar_for_tenant(p_tenant uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select id from public.business_calendars
  where is_default and (tenant_id = p_tenant or tenant_id is null)
  order by (tenant_id is null) asc
  limit 1
$$;

create or replace function private.is_business_day(p_date date, p_calendar uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select extract(isodow from p_date)::int = any (coalesce((select workdays from public.business_calendars where id = p_calendar), '{1,2,3,4,5}'))
     and not exists (
       select 1 from public.holidays h
       where h.calendar_id = p_calendar
         and (h.date = p_date
              or (h.recurring and extract(month from h.date) = extract(month from p_date)
                              and extract(day   from h.date) = extract(day   from p_date))))
$$;

-- Próximo dia útil a partir de p_date (inclusive).
create or replace function public.next_business_day(p_date date, p_calendar uuid default null) returns date
language plpgsql stable security definer set search_path = ''
as $$
declare d date := p_date;
begin
  while not private.is_business_day(d, p_calendar) loop
    d := d + 1;
  end loop;
  return d;
end;
$$;

-- Data de término de uma etapa que começa em p_start e dura p_days dias úteis
-- (contagem inclusiva: 1 dia útil termina no próprio dia de início útil).
create or replace function public.add_business_days(p_start date, p_days int, p_calendar uuid default null) returns date
language plpgsql stable security definer set search_path = ''
as $$
declare
  d date := public.next_business_day(p_start, p_calendar);
  remaining int := greatest(coalesce(p_days, 1), 1) - 1;
begin
  while remaining > 0 loop
    d := d + 1;
    if private.is_business_day(d, p_calendar) then remaining := remaining - 1; end if;
  end loop;
  return d;
end;
$$;

-- Número de dias úteis entre duas datas (inclusivo).
create or replace function public.business_days_between(p_start date, p_end date, p_calendar uuid default null) returns int
language sql stable security definer set search_path = ''
as $$
  select count(*)::int from generate_series(p_start, p_end, interval '1 day') g(d)
  where private.is_business_day(g.d::date, p_calendar)
$$;

-- -----------------------------------------------------------------------------
-- Serviços contratados, trilhas e etapas
-- -----------------------------------------------------------------------------
create table public.project_services (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  service_id         uuid not null references public.services(id) on delete restrict,
  package_id         uuid references public.service_packages(id) on delete set null, -- veio de um pacote
  contracted_at      date,
  status             public.project_service_status not null default 'pending_review',
  contract_source    text,          -- crm | manual
  contract_reference text,          -- ex.: id do card/aditivo
  intake_id          uuid references public.project_intakes(id) on delete set null,
  added_by           uuid references public.profiles(id) on delete set null,
  activated_at       timestamptz,
  completed_at       timestamptz,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index project_services_active_uidx on public.project_services (project_id, service_id) where active;
create index project_services_project_idx on public.project_services (project_id);
create trigger project_services_touch before update on public.project_services
  for each row execute function private.touch_updated_at();

create table public.project_schedule_tracks (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects(id) on delete cascade,
  project_service_id uuid not null unique references public.project_services(id) on delete cascade,
  template_id        uuid references public.schedule_templates(id) on delete restrict, -- versão congelada
  status             public.track_status not null default 'planned',
  planned_start_date date,
  planned_end_date   date,
  actual_start_date  date,
  actual_end_date    date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index project_schedule_tracks_project_idx on public.project_schedule_tracks (project_id);
create trigger project_schedule_tracks_touch before update on public.project_schedule_tracks
  for each row execute function private.touch_updated_at();

create table public.project_tasks (
  id                    uuid primary key default gen_random_uuid(),
  schedule_track_id     uuid not null references public.project_schedule_tracks(id) on delete cascade,
  project_id            uuid not null references public.projects(id) on delete cascade, -- denormalizado p/ RLS
  template_task_id      uuid references public.template_tasks(id) on delete set null,
  code                  text,
  name                  text not null,
  description           text,
  sequence              int not null,
  duration_type         public.duration_type not null default 'fixed',
  planned_duration_days int check (planned_duration_days is null or planned_duration_days > 0),
  planned_start_date    date,
  planned_end_date      date,
  actual_start_date     date,
  actual_end_date       date,
  status                public.task_status not null default 'not_started',
  status_changed_at     timestamptz not null default now(),
  responsible_user_id   uuid references public.profiles(id) on delete set null,
  waiting_reason        text,          -- interno: nunca exposto ao cliente
  notes                 text,
  client_visible        boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint project_tasks_dates_chk check (planned_end_date is null or planned_start_date is null or planned_end_date >= planned_start_date),
  constraint project_tasks_actual_chk check (actual_end_date is null or actual_start_date is null or actual_end_date >= actual_start_date)
);
create index project_tasks_track_idx on public.project_tasks (schedule_track_id, sequence);
create index project_tasks_project_idx on public.project_tasks (project_id, status);
create index project_tasks_responsible_idx on public.project_tasks (responsible_user_id, status, planned_end_date);
create trigger project_tasks_touch before update on public.project_tasks
  for each row execute function private.touch_updated_at();
create trigger project_tasks_audit after insert or update or delete on public.project_tasks
  for each row execute function private.audit_row();

create or replace function private.stamp_task_status()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if new.status is distinct from old.status then new.status_changed_at := now(); end if;
  return new;
end;
$$;
create trigger project_tasks_status_stamp before update on public.project_tasks
  for each row execute function private.stamp_task_status();

-- Dependências reais (mesma trilha ou outra trilha do mesmo projeto).
create table public.task_dependencies (
  id                 uuid primary key default gen_random_uuid(),
  task_id            uuid not null references public.project_tasks(id) on delete cascade,
  depends_on_task_id uuid not null references public.project_tasks(id) on delete cascade,
  dependency_type    public.dependency_type not null default 'finish_to_start',
  lag_days           int not null default 0,
  source             text not null default 'template' check (source in ('template', 'manual')),
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (task_id, depends_on_task_id),
  constraint task_dependencies_self_chk check (task_id <> depends_on_task_id)
);
create index task_dependencies_pred_idx on public.task_dependencies (depends_on_task_id);

-- Dependências só entre etapas do mesmo projeto e sem ciclos.
create or replace function private.guard_task_dependency()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select project_id from public.project_tasks where id = new.task_id)
     is distinct from (select project_id from public.project_tasks where id = new.depends_on_task_id) then
    raise exception 'Dependências só podem ligar etapas do mesmo projeto' using errcode = '23514';
  end if;
  if exists (
    with recursive chain(id) as (
      select new.depends_on_task_id
      union
      select d.depends_on_task_id from public.task_dependencies d join chain c on d.task_id = c.id
    )
    select 1 from chain where id = new.task_id
  ) then
    raise exception 'Esta dependência criaria um ciclo no cronograma' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger task_dependencies_guard before insert or update on public.task_dependencies
  for each row execute function private.guard_task_dependency();
create trigger task_dependencies_audit after insert or delete on public.task_dependencies
  for each row execute function private.audit_row();

-- Histórico de alterações de cronograma (quem, quando, antes, depois, motivo, impacto).
create table public.task_changes (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  task_id           uuid references public.project_tasks(id) on delete set null,
  change_type       text not null check (change_type in ('reschedule','duration','responsible','status','dependency','created','recalculated')),
  before            jsonb,
  after             jsonb,
  reason            text,
  impacted_task_ids uuid[] not null default '{}',
  changed_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  constraint task_changes_reason_chk check (
    change_type not in ('reschedule','duration') or length(trim(coalesce(reason, ''))) >= 3
  )
);
create index task_changes_task_idx on public.task_changes (task_id, created_at desc);
create index task_changes_project_idx on public.task_changes (project_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Guardas de escrita em etapas
--   * Gestores (can_edit_schedule) editam tudo.
--   * Responsável pela etapa (colaborador) só atualiza status, datas reais e observações.
-- -----------------------------------------------------------------------------
create or replace function private.guard_task_write()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  allowed constant text[] := array['status','actual_start_date','actual_end_date','notes','waiting_reason','updated_at','status_changed_at'];
  k text;
begin
  if auth.uid() is null or private.can_edit_schedule(old.project_id) then return new; end if;
  if old.responsible_user_id is distinct from private.current_profile_id() then
    raise exception 'Sem permissão para alterar esta etapa' using errcode = '42501';
  end if;
  for k in select jsonb_object_keys(to_jsonb(new)) loop
    if not (k = any (allowed)) and (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'Você pode atualizar apenas status e datas reais desta etapa' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
create trigger project_tasks_guard before update on public.project_tasks
  for each row execute function private.guard_task_write();

-- Templates: somente ADM Global.
create or replace function private.can_manage_templates() returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_global_admin() $$;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.service_families           enable row level security;
alter table public.services                   enable row level security;
alter table public.service_packages           enable row level security;
alter table public.package_services           enable row level security;
alter table public.schedule_templates         enable row level security;
alter table public.template_tasks             enable row level security;
alter table public.template_task_dependencies enable row level security;
alter table public.business_calendars         enable row level security;
alter table public.holidays                   enable row level security;
alter table public.project_services           enable row level security;
alter table public.project_schedule_tracks    enable row level security;
alter table public.project_tasks              enable row level security;
alter table public.task_dependencies          enable row level security;
alter table public.task_changes               enable row level security;

-- Catálogo: leitura para usuários ativos; escrita ADM Global.
create policy service_families_select on public.service_families for select to authenticated using (private.current_profile_id() is not null);
create policy service_families_write  on public.service_families for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());
create policy services_select on public.services for select to authenticated using (private.current_profile_id() is not null);
create policy services_write  on public.services for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());
create policy service_packages_select on public.service_packages for select to authenticated using (private.is_staff());
create policy service_packages_write  on public.service_packages for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());
create policy package_services_select on public.package_services for select to authenticated using (private.is_staff());
create policy package_services_write  on public.package_services for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());

-- Templates: equipe interna lê; ADM Global edita.
create policy schedule_templates_select on public.schedule_templates for select to authenticated using (private.is_staff());
create policy schedule_templates_write  on public.schedule_templates for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());
create policy template_tasks_select on public.template_tasks for select to authenticated using (private.is_staff());
create policy template_tasks_write  on public.template_tasks for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());
create policy template_deps_select on public.template_task_dependencies for select to authenticated using (private.is_staff());
create policy template_deps_write  on public.template_task_dependencies for all to authenticated using (private.can_manage_templates()) with check (private.can_manage_templates());

-- Calendários: global lido por todos internos; do tenant gerido pela unidade.
create policy business_calendars_select on public.business_calendars for select to authenticated
  using (private.is_staff() and (tenant_id is null or private.can_access_tenant(tenant_id)));
create policy business_calendars_write on public.business_calendars for all to authenticated
  using ((tenant_id is null and private.is_global_admin()) or (tenant_id is not null and private.can_manage_tenant(tenant_id)))
  with check ((tenant_id is null and private.is_global_admin()) or (tenant_id is not null and private.can_manage_tenant(tenant_id)));
create policy holidays_select on public.holidays for select to authenticated
  using (exists (select 1 from public.business_calendars c where c.id = calendar_id
                 and private.is_staff() and (c.tenant_id is null or private.can_access_tenant(c.tenant_id))));
create policy holidays_write on public.holidays for all to authenticated
  using (exists (select 1 from public.business_calendars c where c.id = calendar_id
                 and ((c.tenant_id is null and private.is_global_admin()) or (c.tenant_id is not null and private.can_manage_tenant(c.tenant_id)))))
  with check (exists (select 1 from public.business_calendars c where c.id = calendar_id
                 and ((c.tenant_id is null and private.is_global_admin()) or (c.tenant_id is not null and private.can_manage_tenant(c.tenant_id)))));

-- Serviços contratados e trilhas: quem vê o projeto (inclusive cliente) lê; gestor edita.
create policy project_services_select on public.project_services for select to authenticated using (private.can_view_project(project_id));
create policy project_services_write  on public.project_services for all to authenticated
  using (private.can_edit_schedule(project_id)) with check (private.can_edit_schedule(project_id));
create policy tracks_select on public.project_schedule_tracks for select to authenticated using (private.can_view_project(project_id));
create policy tracks_write  on public.project_schedule_tracks for all to authenticated
  using (private.can_edit_schedule(project_id)) with check (private.can_edit_schedule(project_id));

-- Etapas: somente equipe interna lê direto (cliente usa RPC com colunas seguras, sem
-- justificativas internas). Gestor edita tudo; responsável atualiza a própria etapa (guarda acima).
create policy project_tasks_select on public.project_tasks for select to authenticated
  using (private.is_staff() and private.can_view_project(project_id));
create policy project_tasks_insert on public.project_tasks for insert to authenticated
  with check (private.can_edit_schedule(project_id));
create policy project_tasks_update on public.project_tasks for update to authenticated
  using (private.can_edit_schedule(project_id)
         or (responsible_user_id = private.current_profile_id() and private.can_view_project(project_id)))
  with check (private.can_view_project(project_id));
create policy project_tasks_delete on public.project_tasks for delete to authenticated
  using (private.can_edit_schedule(project_id));

create policy task_dependencies_select on public.task_dependencies for select to authenticated
  using (exists (select 1 from public.project_tasks t where t.id = task_id and private.is_staff() and private.can_view_project(t.project_id)));
create policy task_dependencies_write on public.task_dependencies for all to authenticated
  using (exists (select 1 from public.project_tasks t where t.id = task_id and private.can_edit_schedule(t.project_id)))
  with check (exists (select 1 from public.project_tasks t where t.id = task_id and private.can_edit_schedule(t.project_id)));

-- Histórico: equipe interna lê; inserção via RPCs de cronograma (security definer).
create policy task_changes_select on public.task_changes for select to authenticated
  using (private.is_staff() and private.can_view_project(project_id));

-- Privilégios
revoke all on public.service_families, public.services, public.service_packages, public.package_services,
              public.schedule_templates, public.template_tasks, public.template_task_dependencies,
              public.business_calendars, public.holidays, public.project_services, public.project_schedule_tracks,
              public.project_tasks, public.task_dependencies, public.task_changes from anon;
grant select, insert, update, delete on public.service_families, public.services, public.service_packages,
              public.package_services, public.schedule_templates, public.template_tasks,
              public.template_task_dependencies, public.business_calendars, public.holidays,
              public.project_services, public.project_schedule_tracks, public.project_tasks,
              public.task_dependencies to authenticated;
grant select on public.task_changes to authenticated;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated, service_role;
revoke execute on function public.next_business_day(date, uuid), public.add_business_days(date, int, uuid),
                           public.business_days_between(date, date, uuid) from anon, public;
grant execute on function public.next_business_day(date, uuid), public.add_business_days(date, int, uuid),
                          public.business_days_between(date, date, uuid) to authenticated, service_role;
