// Camada única de acesso a dados. Componentes nunca chamam o Supabase direto.
// Toda autorização é revalidada no banco (RLS + funções private.can_*).
import { supabase } from "./supabase";
import { toUserError, UserFacingError } from "./errors";
import type {
  ClientRecord, ClientType, EmploymentType, HomeDashboard, Permissions, Profile,
  RecordStatus, Tenant, TenantOverview, UserRole,
} from "@/types/domain";

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toUserError(error);
  return data as T;
}

/** Chama a Edge Function admin-users e devolve a mensagem de erro do servidor quando houver. */
async function adminUsers<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("admin-users", { body });
  if (error) {
    let message = "Não foi possível concluir. Nada foi alterado. Tente novamente.";
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const payload = await ctx.json();
        if (payload?.message) message = payload.message;
      } catch { /* resposta sem JSON */ }
    }
    throw new UserFacingError(message);
  }
  return data as T;
}

const PROFILE_COLUMNS =
  "id, auth_user_id, tenant_id, name, email, role, employment_type, client_type, status, phone, avatar_url, invited_at, last_seen_at, created_at";

export const api = {
  // ---------- Sessão ----------
  myPermissions: () => rpc<Permissions | null>("my_permissions"),

  async myProfile(profileId: string): Promise<Profile> {
    const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", profileId).single();
    if (error) throw toUserError(error);
    return data as Profile;
  },

  // ---------- Home ----------
  homeDashboard: () => rpc<HomeDashboard>("get_home_dashboard"),

  // ---------- Unidades ----------
  async listTenants(): Promise<Tenant[]> {
    const { data, error } = await supabase.from("tenants")
      .select("id, name, type, status, parent_tenant_id, slug, city, state, created_at")
      .order("type").order("name");
    if (error) throw toUserError(error);
    return data as Tenant[];
  },
  tenantOverview: () => rpc<TenantOverview[]>("tenant_overview"),
  createTenant: (input: { name: string; slug: string; city?: string | null; state?: string | null }) =>
    rpc<string>("admin_create_tenant", {
      p_name: input.name, p_slug: input.slug, p_city: input.city || null, p_state: input.state || null,
    }),
  async updateTenant(id: string, patch: Partial<Pick<Tenant, "name" | "city" | "state" | "status">>): Promise<void> {
    const { error } = await supabase.from("tenants").update(patch).eq("id", id);
    if (error) throw toUserError(error);
  },

  // ---------- Usuários ----------
  async listProfiles(): Promise<Profile[]> {
    const { data, error } = await supabase.from("profiles").select(PROFILE_COLUMNS).order("name");
    if (error) throw toUserError(error);
    return data as Profile[];
  },
  inviteUser: (input: {
    tenant_id: string; name: string; email: string; role: UserRole;
    employment_type?: EmploymentType | null; client_type?: ClientType | null; client_id?: string | null; phone?: string | null;
  }) => adminUsers<{ profile_id: string }>({ action: "invite", ...input }),
  updateUser: (input: {
    profile_id: string; name: string; role: UserRole; employment_type?: EmploymentType | null;
    client_type?: ClientType | null; phone?: string | null; tenant_id?: string | null;
  }) => adminUsers<{ updated: boolean }>({ action: "update", ...input }),
  setUserStatus: (profile_id: string, status: RecordStatus) =>
    adminUsers<{ updated: boolean; sessions_revoked: boolean }>({ action: "set_status", profile_id, status }),
  resendInvite: (profile_id: string) => adminUsers<{ sent: boolean }>({ action: "resend_invite", profile_id }),

  // ---------- Clientes (mínimo necessário para vincular usuários-cliente) ----------
  async listClients(tenantId: string): Promise<ClientRecord[]> {
    const { data, error } = await supabase.from("clients")
      .select("id, tenant_id, name, client_type, email, status")
      .eq("tenant_id", tenantId).eq("status", "ativo").order("name");
    if (error) throw toUserError(error);
    return data as ClientRecord[];
  },
  async createClient(input: { tenant_id: string; name: string; client_type: ClientType; email?: string | null }): Promise<string> {
    const id = crypto.randomUUID();
    const { error } = await supabase.from("clients").insert({ id, ...input, email: input.email || null });
    if (error) throw toUserError(error);
    return id;
  },
};
