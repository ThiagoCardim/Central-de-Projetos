-- =============================================================================
-- Portal de Projetos YouCon — Migration 0008: vínculo automático de convite
--
-- Quando um usuário é criado no Supabase Auth (convite pelo app ou pelo painel)
-- e já existe um perfil pendente com o mesmo e-mail, liga os dois. O cadastro
-- público fica desligado, então só administradores criam usuários de Auth.
-- =============================================================================
create or replace function private.link_profile_on_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set auth_user_id = new.id
   where auth_user_id is null
     and email = lower(new.email);
  return new;
end;
$$;
revoke all on function private.link_profile_on_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created_link_profile
  after insert on auth.users
  for each row execute function private.link_profile_on_auth_user();
