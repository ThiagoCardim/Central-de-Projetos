// Camada única de acesso a dados. Componentes nunca chamam o Supabase direto.
// Toda autorização é revalidada no banco (RLS + funções private.can_*).
import { supabase } from "./supabase";
import { toUserError, UserFacingError } from "./errors";
import type {
  ClientListItem, ClientRecord, ClientType, EmploymentType, HomeDashboard, Intake, Permissions, Profile,
  ProjectDetail, ProjectListItem, ProjectRole, RecordStatus, StaffMember, Tenant, TenantOverview, UserRole,
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

  // ---------- Central de Entrada ----------
  async listIntakes(): Promise<Intake[]> {
    const { data, error } = await supabase.from("project_intakes")
      .select("id, source, external_id, intake_kind, target_external_id, client_name, client_email, client_phone, client_document, client_type, project_name, project_type, services, resolved_services, contracted_at, contract_value, area_m2, city, state, address, salesperson, notes, status, validation_error, validation_details, received_at, processed_at, created_project_id, raw_payload")
      .order("received_at", { ascending: false }).limit(300);
    if (error) throw toUserError(error);
    return data as Intake[];
  },
  createManualIntake: (payload: Record<string, unknown>) =>
    rpc<{ status: string; project_id?: string; errors?: string[] }>("create_manual_intake", { p_payload: payload }),
  reprocessIntake: (id: string, fields: Record<string, unknown>) =>
    rpc<{ status: string; project_id?: string; errors?: string[] }>("reprocess_intake", { p_intake: id, p_fields: fields }),
  ignoreIntake: (id: string, reason: string) => rpc<void>("ignore_intake", { p_intake: id, p_reason: reason }),

  /** Nomes de serviços e pacotes ativos (sugestões ao digitar). */
  async listServicesCatalog(): Promise<string[]> {
    const [svc, pkg] = await Promise.all([
      supabase.from("services").select("name").eq("active", true).order("sort_order"),
      supabase.from("service_packages").select("name").eq("active", true),
    ]);
    if (svc.error) throw toUserError(svc.error);
    return [...(svc.data ?? []).map((r) => r.name as string), ...(pkg.data ?? []).map((r) => r.name as string)];
  },

  // ---------- Projetos ----------
  async listProjects(): Promise<ProjectListItem[]> {
    const { data, error } = await supabase.from("projects")
      .select("id, code, name, status, client_type, project_type, city, state, contracted_at, created_at, delivery_tenant_id, client:clients(id, name), delivery:tenants!projects_delivery_tenant_id_fkey(name), services:project_services(id, status, active, service:services(name))")
      .order("created_at", { ascending: false });
    if (error) throw toUserError(error);
    return data as unknown as ProjectListItem[];
  },
  async getProject(id: string): Promise<ProjectDetail | null> {
    const { data, error } = await supabase.from("projects")
      .select(`id, code, name, status, client_type, project_type, city, state, address, area_m2, contracted_at, created_at, started_at,
        external_source, external_id, origin_tenant_id, commercial_tenant_id, delivery_tenant_id,
        client:clients(id, tenant_id, name, client_type, email, phone, document, company_name, status),
        origin:tenants!projects_origin_tenant_id_fkey(name),
        commercial:tenants!projects_commercial_tenant_id_fkey(name),
        delivery:tenants!projects_delivery_tenant_id_fkey(name),
        services:project_services(id, status, active, contracted_at, contract_source, service:services(id, name, code, family:service_families(name, default_project_role))),
        team:project_team(id, project_role, employment_type, active, assigned_at, user:profiles!project_team_user_id_fkey(id, name, avatar_url, employment_type)),
        allocations:project_allocations(id, allocation_method, allocation_status, allocated_at, notes, created_at, delivery:tenants!project_allocations_delivery_tenant_id_fkey(name))`)
      .eq("id", id).maybeSingle();
    if (error) throw toUserError(error);
    return data as unknown as ProjectDetail | null;
  },
  async listProjectRoles(): Promise<ProjectRole[]> {
    const { data, error } = await supabase.from("project_roles").select("code, name, sort_order, required").eq("active", true).order("sort_order");
    if (error) throw toUserError(error);
    return data as ProjectRole[];
  },
  async listStaff(tenantId: string): Promise<StaffMember[]> {
    const { data, error } = await supabase.from("profiles")
      .select("id, name, role, employment_type, avatar_url, tenant_id")
      .eq("tenant_id", tenantId).eq("status", "ativo").in("role", ["collaborator", "leader", "unit_admin"]).order("name");
    if (error) throw toUserError(error);
    return data as StaffMember[];
  },
  assignTeam: (projectId: string, assignments: { project_role: string; user_id: string }[]) =>
    rpc<{ started: boolean; added: number; removed: number }>("assign_project_team", { p_project: projectId, p_assignments: assignments }),
  allocateProject: (projectId: string, tenantId: string, notes: string) =>
    rpc<void>("allocate_project", { p_project: projectId, p_delivery_tenant: tenantId, p_notes: notes || null }),

  // ---------- Clientes ----------
  async listClientsWithProjects(): Promise<ClientListItem[]> {
    const { data, error } = await supabase.from("clients")
      .select("id, tenant_id, name, client_type, email, phone, document, company_name, status, created_at, projects(count)")
      .order("name");
    if (error) throw toUserError(error);
    return data as unknown as ClientListItem[];
  },
  async saveClient(input: { id?: string; tenant_id: string; name: string; client_type: ClientType; email?: string | null;
    phone?: string | null; document?: string | null; company_name?: string | null }): Promise<void> {
    const row = {
      tenant_id: input.tenant_id, name: input.name.trim(), client_type: input.client_type,
      email: input.email?.trim().toLowerCase() || null, phone: input.phone?.trim() || null,
      document: input.document?.replace(/\D/g, "") || null, company_name: input.company_name?.trim() || null,
    };
    const { error } = input.id
      ? await supabase.from("clients").update(row).eq("id", input.id)
      : await supabase.from("clients").insert({ id: crypto.randomUUID(), ...row });
    if (error) throw toUserError(error);
  },

  // ---------- Equipe ----------
  async teamWorkload(tenantId: string | null): Promise<{ user_id: string; project_role: string; project: { id: string; name: string; status: string } | null }[]> {
    let q = supabase.from("project_team").select("user_id, project_role, project:projects!inner(id, name, status, delivery_tenant_id)").eq("active", true);
    if (tenantId) q = q.eq("project.delivery_tenant_id", tenantId);
    const { data, error } = await q;
    if (error) throw toUserError(error);
    return (data ?? []) as unknown as { user_id: string; project_role: string; project: { id: string; name: string; status: string } | null }[];
  },
};
