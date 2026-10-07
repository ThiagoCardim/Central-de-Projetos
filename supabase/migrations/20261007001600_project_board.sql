-- =============================================================================
-- Portal de Projetos YouCon — Migration 0016 (Etapa 3.1): quadro Kanban de projetos.
--
-- Cada unidade organiza seus projetos em colunas próprias (isolamento entre
-- franquias). As colunas são etapas de organização da equipe e NÃO mudam o
-- status do projeto (distribuição, equipe e cronograma seguem suas regras).
--   * Colunas: criar, renomear, reordenar e excluir (gestores da unidade).
--   * Excluir exige digitar o nome da coluna e escolher para onde vão os cards.
--   * Sem DELETE: coluna excluída fica inativa (histórico preservado).
--   * Projeto sem posição aparece na primeira coluna.
-- =============================================================================

create table public.project_board_columns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  sort_order int not null default 0,
  active boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_by uuid references public.profiles (id),
  removed_at timestamptz
);
create unique index project_board_columns_name_uq on public.project_board_columns (tenant_id, lower(trim(name))) where active;
create index project_board_columns_tenant_idx on public.project_board_columns (tenant_id, sort_order) where active;

create table public.project_board_cards (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  column_id uuid not null references public.project_board_columns (id),
  sort_order numeric not null default 0,
  moved_by uuid references public.profiles (id),
  moved_at timestamptz not null default now(),
  primary key (tenant_id, project_id)
);
create index project_board_cards_column_idx on public.project_board_cards (column_id, sort_order);

alter table public.project_board_columns enable row level security;
alter table public.project_board_cards enable row level security;
create policy project_board_columns_select on public.project_board_columns for select to authenticated
  using ((select private.is_staff()) and tenant_id = (select private.current_tenant_id()));
create policy project_board_cards_select on public.project_board_cards for select to authenticated
  using ((select private.is_staff()) and tenant_id = (select private.current_tenant_id()) and (select private.can_view_project(project_id)));
grant select on public.project_board_columns, public.project_board_cards to authenticated;
-- Escrita só pelas funções abaixo.

create trigger project_board_columns_touch before update on public.project_board_columns
  for each row execute function private.touch_updated_at();
create trigger project_board_columns_audit after insert or update on public.project_board_columns
  for each row execute function private.audit_row();

-- -----------------------------------------------------------------------------
-- Garante o quadro da unidade (colunas iniciais na primeira abertura).
-- Colunas iniciais são só um ponto de partida e podem ser renomeadas/excluídas.
-- -----------------------------------------------------------------------------
create or replace function private.board_ensure()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := private.current_tenant_id();
  c_start uuid; c_doing uuid; c_done uuid;
begin
  if not private.is_staff() or v_tenant is null then
    raise exception 'Sem acesso ao quadro de projetos' using errcode = '42501';
  end if;
  if exists (select 1 from public.project_board_columns where tenant_id = v_tenant) then return; end if;

  insert into public.project_board_columns (tenant_id, name, sort_order, created_by)
  values (v_tenant, 'A iniciar', 10, private.current_profile_id()) returning id into c_start;
  insert into public.project_board_columns (tenant_id, name, sort_order, created_by)
  values (v_tenant, 'Em andamento', 20, private.current_profile_id()) returning id into c_doing;
  insert into public.project_board_columns (tenant_id, name, sort_order, created_by)
  values (v_tenant, 'Encerrados', 30, private.current_profile_id()) returning id into c_done;

  -- Posição inicial pela situação atual de cada projeto da unidade
  -- (a Franqueadora organiza todos). A leitura continua filtrada por can_view_project.
  insert into public.project_board_cards (tenant_id, project_id, column_id, sort_order, moved_by)
  select v_tenant, p.id,
         case when p.status in ('awaiting_allocation', 'awaiting_team_assignment') then c_start
              when p.status in ('completed', 'cancelled') then c_done
              else c_doing end,
         row_number() over (order by p.contracted_at desc nulls last, p.created_at desc) * 10,
         private.current_profile_id()
  from public.projects p
  where exists (select 1 from public.tenants t where t.id = v_tenant and t.type = 'franqueadora')
     or v_tenant in (p.delivery_tenant_id, p.commercial_tenant_id, p.origin_tenant_id);
end;
$$;

create or replace function private.board_require_manager()
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_tenant uuid := private.current_tenant_id();
begin
  if not private.is_manager() or v_tenant is null then
    raise exception 'Somente gestores da unidade editam o quadro' using errcode = '42501';
  end if;
  return v_tenant;
end;
$$;

create or replace function private.board_add_column(p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid := private.board_require_manager(); v_id uuid;
begin
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Informe o nome da coluna' using errcode = '23514'; end if;
  if exists (select 1 from public.project_board_columns where tenant_id = v_tenant and active and lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'Já existe uma coluna com este nome' using errcode = '23505';
  end if;
  insert into public.project_board_columns (tenant_id, name, sort_order, created_by)
  values (v_tenant, trim(p_name),
          coalesce((select max(sort_order) from public.project_board_columns where tenant_id = v_tenant and active), 0) + 10,
          private.current_profile_id())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function private.board_rename_column(p_column uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid := private.board_require_manager();
begin
  if length(trim(coalesce(p_name, ''))) = 0 then raise exception 'Informe o nome da coluna' using errcode = '23514'; end if;
  if not exists (select 1 from public.project_board_columns where id = p_column and tenant_id = v_tenant and active) then
    raise exception 'Coluna não encontrada' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.project_board_columns where tenant_id = v_tenant and active and id <> p_column and lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'Já existe uma coluna com este nome' using errcode = '23505';
  end if;
  update public.project_board_columns set name = trim(p_name) where id = p_column;
end;
$$;

create or replace function private.board_reorder_columns(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid := private.board_require_manager(); i int;
begin
  for i in 1 .. coalesce(array_length(p_ids, 1), 0) loop
    update public.project_board_columns set sort_order = i * 10
     where id = p_ids[i] and tenant_id = v_tenant and active;
  end loop;
end;
$$;

-- Exclusão segura: confirmação pelo nome + destino dos cards.
create or replace function private.board_delete_column(p_column uuid, p_move_to uuid, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := private.board_require_manager();
  c public.project_board_columns;
  v_moved int;
begin
  select * into c from public.project_board_columns where id = p_column and tenant_id = v_tenant and active;
  if c.id is null then raise exception 'Coluna não encontrada' using errcode = 'P0002'; end if;
  if lower(trim(coalesce(p_confirm, ''))) <> lower(trim(c.name)) then
    raise exception 'Para excluir, digite exatamente o nome da coluna: %', c.name using errcode = '23514';
  end if;
  if (select count(*) from public.project_board_columns where tenant_id = v_tenant and active) <= 1 then
    raise exception 'O quadro precisa de pelo menos uma coluna' using errcode = '23514';
  end if;
  if p_move_to is null or p_move_to = p_column
     or not exists (select 1 from public.project_board_columns where id = p_move_to and tenant_id = v_tenant and active) then
    raise exception 'Escolha para qual coluna os projetos serão movidos' using errcode = '23514';
  end if;

  update public.project_board_cards
     set column_id = p_move_to,
         sort_order = coalesce((select max(sort_order) from public.project_board_cards where column_id = p_move_to), 0) + sort_order,
         moved_by = private.current_profile_id(), moved_at = now()
   where column_id = p_column and tenant_id = v_tenant;
  get diagnostics v_moved = row_count;

  update public.project_board_columns set active = false, removed_at = now(), removed_by = private.current_profile_id() where id = c.id;
  perform private.log_audit('board_column_deleted', 'project_board_columns', c.id, null,
    jsonb_build_object('name', c.name, 'moved_to', p_move_to, 'projects_moved', v_moved));
  return jsonb_build_object('moved', v_moved);
end;
$$;

-- Move um card para uma coluna, antes de outro card (ou no fim).
create or replace function private.board_move_card(p_project uuid, p_column uuid, p_before uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := private.board_require_manager();
  v_order numeric;
  v_prev numeric;
begin
  if not private.can_view_project(p_project) then raise exception 'Projeto não encontrado' using errcode = '42501'; end if;
  if not exists (select 1 from public.project_board_columns where id = p_column and tenant_id = v_tenant and active) then
    raise exception 'Coluna não encontrada' using errcode = 'P0002';
  end if;
  if p_before is not null then
    select sort_order into v_order from public.project_board_cards where tenant_id = v_tenant and project_id = p_before and column_id = p_column;
  end if;
  if v_order is null then
    v_order := coalesce((select max(sort_order) from public.project_board_cards where tenant_id = v_tenant and column_id = p_column and project_id <> p_project), 0) + 10;
  else
    select max(sort_order) into v_prev from public.project_board_cards
     where tenant_id = v_tenant and column_id = p_column and sort_order < v_order and project_id <> p_project;
    v_order := (coalesce(v_prev, v_order - 20) + v_order) / 2;
  end if;
  insert into public.project_board_cards (tenant_id, project_id, column_id, sort_order, moved_by, moved_at)
  values (v_tenant, p_project, p_column, v_order, private.current_profile_id(), now())
  on conflict (tenant_id, project_id) do update
    set column_id = excluded.column_id, sort_order = excluded.sort_order, moved_by = excluded.moved_by, moved_at = now();
end;
$$;

-- Wrappers públicos
create or replace function public.board_ensure() returns void
language sql security invoker set search_path = '' as $$ select private.board_ensure() $$;
create or replace function public.board_add_column(p_name text) returns uuid
language sql security invoker set search_path = '' as $$ select private.board_add_column(p_name) $$;
create or replace function public.board_rename_column(p_column uuid, p_name text) returns void
language sql security invoker set search_path = '' as $$ select private.board_rename_column(p_column, p_name) $$;
create or replace function public.board_reorder_columns(p_ids uuid[]) returns void
language sql security invoker set search_path = '' as $$ select private.board_reorder_columns(p_ids) $$;
create or replace function public.board_delete_column(p_column uuid, p_move_to uuid, p_confirm text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.board_delete_column(p_column, p_move_to, p_confirm) $$;
create or replace function public.board_move_card(p_project uuid, p_column uuid, p_before uuid default null) returns void
language sql security invoker set search_path = '' as $$ select private.board_move_card(p_project, p_column, p_before) $$;

revoke all on function public.board_ensure(), public.board_add_column(text), public.board_rename_column(uuid, text),
  public.board_reorder_columns(uuid[]), public.board_delete_column(uuid, uuid, text), public.board_move_card(uuid, uuid, uuid) from public, anon;
grant execute on function public.board_ensure(), public.board_add_column(text), public.board_rename_column(uuid, text),
  public.board_reorder_columns(uuid[]), public.board_delete_column(uuid, uuid, text), public.board_move_card(uuid, uuid, uuid) to authenticated;
revoke all on function private.board_ensure(), private.board_require_manager(), private.board_add_column(text), private.board_rename_column(uuid, text),
  private.board_reorder_columns(uuid[]), private.board_delete_column(uuid, uuid, text), private.board_move_card(uuid, uuid, uuid) from public, anon;
grant execute on function private.board_ensure(), private.board_require_manager(), private.board_add_column(text), private.board_rename_column(uuid, text),
  private.board_reorder_columns(uuid[]), private.board_delete_column(uuid, uuid, text), private.board_move_card(uuid, uuid, uuid) to authenticated, service_role;
