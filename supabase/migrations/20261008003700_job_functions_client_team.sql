-- =============================================================================
-- 0037 · Funções da equipe e "Equipe do seu projeto" para o cliente
--
--   * Cadastro de funções por unidade (Profissão › Especialidade), mantido pela
--     administração em Configurações. Ex.: Engenheiro › Estrutural.
--   * Cada pessoa pode ter várias funções e uma breve descrição (aparece para o
--     cliente). Definidas pela gestão na aba Equipe.
--   * client_project_team(): quem cuida do projeto (equipe vinculada e
--     responsáveis pelos serviços contratados), com papel, funções e descrição.
--     Sem dados internos (e-mail, telefone, performance).
-- =============================================================================

create table public.job_functions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  profession  text not null check (length(trim(profession)) between 2 and 40),
  specialty   text check (specialty is null or length(trim(specialty)) between 1 and 60),
  sort_order  int not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index job_functions_name_key on public.job_functions (tenant_id, lower(trim(profession)), lower(coalesce(trim(specialty), '')));
create trigger job_functions_touch before update on public.job_functions for each row execute function private.touch_updated_at();
alter table public.job_functions enable row level security;
create policy job_functions_select on public.job_functions for select to authenticated using (private.can_access_tenant(tenant_id));
revoke all on public.job_functions from anon;
grant select on public.job_functions to authenticated;

alter table public.profiles
  add column function_ids uuid[] not null default '{}',
  add column bio text check (bio is null or length(bio) <= 500);

insert into public.job_functions (tenant_id, profession, specialty, sort_order)
select t.id, f.p, f.s, f.o from public.tenants t
cross join (values ('Engenheiro', 'Estrutural', 10), ('Engenheiro', 'Elétrico', 20), ('Engenheiro', 'Hidráulico', 30),
                   ('Arquiteto', 'Arquitetônico', 40), ('Arquiteto', 'Interiores', 50)) f(p, s, o)
on conflict do nothing;

create or replace function private.job_function_label(f public.job_functions) returns text
language sql immutable set search_path = ''
as $$ select f.profession || coalesce(' › ' || f.specialty, '') $$;

-- ---------------------------------------------------------------------------
-- Cadastro (administração)
-- ---------------------------------------------------------------------------
create or replace function private.job_function_save(p_tenant uuid, p_id uuid, p_profession text, p_specialty text) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid; v_tenant uuid := p_tenant; v_prof text := trim(p_profession); v_spec text := nullif(trim(p_specialty), '');
begin
  if p_id is not null then select tenant_id into v_tenant from public.job_functions where id = p_id; end if;
  if v_tenant is null or not private.can_manage_tenant(v_tenant) then
    raise exception 'Só a administração altera as funções' using errcode = '42501';
  end if;
  if v_prof is null or length(v_prof) < 2 then raise exception 'Informe a profissão' using errcode = '23514'; end if;
  if exists (select 1 from public.job_functions where tenant_id = v_tenant and lower(trim(profession)) = lower(v_prof)
             and lower(coalesce(trim(specialty), '')) = lower(coalesce(v_spec, '')) and archived_at is null and id is distinct from p_id) then
    raise exception 'Essa função já existe' using errcode = '23505';
  end if;
  select id into v_id from public.job_functions where tenant_id = v_tenant and lower(trim(profession)) = lower(v_prof)
     and lower(coalesce(trim(specialty), '')) = lower(coalesce(v_spec, '')) and archived_at is not null;
  if v_id is not null then
    if p_id is not null then raise exception 'Já existe uma função excluída com esse nome; inclua-a novamente' using errcode = '23505'; end if;
    update public.job_functions set archived_at = null, profession = v_prof, specialty = v_spec,
      sort_order = coalesce((select max(sort_order) from public.job_functions where tenant_id = v_tenant and archived_at is null), 0) + 10
     where id = v_id;
    return v_id;
  end if;
  if p_id is null then
    insert into public.job_functions (tenant_id, profession, specialty, sort_order)
    values (v_tenant, v_prof, v_spec, coalesce((select max(sort_order) from public.job_functions where tenant_id = v_tenant and archived_at is null), 0) + 10)
    returning id into v_id;
  else
    update public.job_functions set profession = v_prof, specialty = v_spec where id = p_id returning id into v_id;
  end if;
  perform private.log_audit(case when p_id is null then 'job_function_created' else 'job_function_renamed' end, 'job_functions', v_id, v_tenant,
    jsonb_build_object('profession', v_prof, 'specialty', v_spec));
  return v_id;
end;
$$;

-- Exclusão lógica: some das telas e deixa de aparecer nas pessoas.
create or replace function private.job_function_delete(p_id uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare f public.job_functions; v_n int;
begin
  select * into f from public.job_functions where id = p_id and archived_at is null;
  if f.id is null then raise exception 'Função não encontrada' using errcode = 'P0002'; end if;
  if not private.can_manage_tenant(f.tenant_id) then raise exception 'Só a administração altera as funções' using errcode = '42501'; end if;
  update public.profiles set function_ids = array_remove(function_ids, p_id) where p_id = any (function_ids);
  get diagnostics v_n = row_count;
  update public.job_functions set archived_at = now() where id = p_id;
  perform private.log_audit('job_function_deleted', 'job_functions', p_id, f.tenant_id, jsonb_build_object('label', private.job_function_label(f), 'people', v_n));
  return v_n;
end;
$$;

create or replace function private.job_function_reorder(p_tenant uuid, p_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_tenant(p_tenant) then raise exception 'Só a administração altera as funções' using errcode = '42501'; end if;
  update public.job_functions f set sort_order = x.ord * 10
    from unnest(p_ids) with ordinality x(id, ord)
   where f.id = x.id and f.tenant_id = p_tenant;
end;
$$;

create or replace function private.job_function_list(p_tenant uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'profession', f.profession, 'specialty', f.specialty, 'sort_order', f.sort_order,
    'people', (select count(*) from public.profiles p where f.id = any (p.function_ids) and p.status = 'ativo')) order by f.sort_order, f.profession, f.specialty), '[]'::jsonb)
  from public.job_functions f
  where f.tenant_id = p_tenant and f.archived_at is null and private.can_access_tenant(p_tenant)
$$;

-- Funções e descrição da pessoa (gestão).
create or replace function private.set_person_profile(p_profile uuid, p_functions uuid[], p_bio text) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tenant uuid; v_ids uuid[] := coalesce(p_functions, '{}');
begin
  select tenant_id into v_tenant from public.profiles where id = p_profile;
  if not (private.can_lead_person(p_profile) or private.can_manage_users(v_tenant)) then
    raise exception 'Sem permissão para alterar o perfil profissional desta pessoa' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_ids) x(id)
             where not exists (select 1 from public.job_functions f where f.id = x.id and f.tenant_id = v_tenant and f.archived_at is null)) then
    raise exception 'Função inválida para a unidade desta pessoa' using errcode = '23514';
  end if;
  if length(coalesce(p_bio, '')) > 500 then raise exception 'A descrição pode ter até 500 caracteres' using errcode = '23514'; end if;
  update public.profiles set function_ids = (select coalesce(array_agg(distinct x), '{}') from unnest(v_ids) x),
                             bio = nullif(trim(p_bio), '')
   where id = p_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- Equipe do projeto (para o cliente e para a equipe)
-- ---------------------------------------------------------------------------
create or replace function private.client_project_team(p_project uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  with members as (
    select t.user_id as pid, r.name as role_name, r.code as role_code, r.sort_order as ord
    from public.project_team t join public.project_roles r on r.code = t.project_role
    where t.project_id = p_project and t.active
    union all
    select ps.responsible_user_id, 'Responsável por ' || s.name, 'service', 50
    from public.project_services ps join public.services s on s.id = ps.service_id
    where ps.project_id = p_project and ps.active and ps.responsible_user_id is not null
  ),
  people as (
    select m.pid, min(m.ord) as ord, bool_or(m.role_code like 'lead\_%') as is_leader,
           array_agg(distinct m.role_name) filter (where m.role_code like 'lead\_%' or m.role_code = 'service') as roles,
           array_agg(distinct m.role_name) filter (where m.role_code not like 'lead\_%' and m.role_code <> 'service' and m.role_code <> 'support') as areas
    from members m group by m.pid
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'avatar_url', p.avatar_url, 'bio', p.bio, 'is_leader', x.is_leader,
      'roles', coalesce(to_jsonb(x.roles), '[]'::jsonb), 'areas', coalesce(to_jsonb(x.areas), '[]'::jsonb),
      'functions', (select coalesce(jsonb_agg(private.job_function_label(f) order by f.sort_order), '[]'::jsonb)
                    from public.job_functions f where f.id = any (p.function_ids) and f.archived_at is null))
      order by not x.is_leader, x.ord, p.name), '[]'::jsonb)
  from people x join public.profiles p on p.id = x.pid
  where private.can_view_project(p_project) and p.status = 'ativo' and p.role <> 'client'
$$;

create or replace function public.job_function_save(p_tenant uuid, p_id uuid, p_profession text, p_specialty text) returns uuid
language sql security invoker set search_path = '' as $$ select private.job_function_save(p_tenant, p_id, p_profession, p_specialty) $$;
create or replace function public.job_function_delete(p_id uuid) returns int
language sql security invoker set search_path = '' as $$ select private.job_function_delete(p_id) $$;
create or replace function public.job_function_reorder(p_tenant uuid, p_ids uuid[]) returns void
language sql security invoker set search_path = '' as $$ select private.job_function_reorder(p_tenant, p_ids) $$;
create or replace function public.job_function_list(p_tenant uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.job_function_list(p_tenant) $$;
create or replace function public.set_person_profile(p_profile uuid, p_functions uuid[], p_bio text) returns void
language sql security invoker set search_path = '' as $$ select private.set_person_profile(p_profile, p_functions, p_bio) $$;
create or replace function public.client_project_team(p_project uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.client_project_team(p_project) $$;

revoke all on function private.job_function_save(uuid, uuid, text, text), private.job_function_delete(uuid), private.job_function_reorder(uuid, uuid[]),
  private.job_function_list(uuid), private.set_person_profile(uuid, uuid[], text), private.client_project_team(uuid),
  public.job_function_save(uuid, uuid, text, text), public.job_function_delete(uuid), public.job_function_reorder(uuid, uuid[]),
  public.job_function_list(uuid), public.set_person_profile(uuid, uuid[], text), public.client_project_team(uuid) from public, anon;
grant execute on function private.job_function_save(uuid, uuid, text, text), private.job_function_delete(uuid), private.job_function_reorder(uuid, uuid[]),
  private.job_function_list(uuid), private.set_person_profile(uuid, uuid[], text), private.client_project_team(uuid), private.job_function_label(public.job_functions),
  public.job_function_save(uuid, uuid, text, text), public.job_function_delete(uuid), public.job_function_reorder(uuid, uuid[]),
  public.job_function_list(uuid), public.set_person_profile(uuid, uuid[], text), public.client_project_team(uuid) to authenticated;
