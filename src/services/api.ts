// Camada única de acesso a dados. Componentes nunca chamam o Supabase direto.
// Toda autorização é revalidada no banco (RLS + funções private.can_*).
import { supabase } from "./supabase";
import { toUserError, UserFacingError } from "./errors";
import type {
  AdjustmentAttachment, AdjustmentComplexity, AdjustmentRequest, ProjectType, ReasonKind, SaleServiceOption, TaskNote, MyStep, WorkItem, TeamPerson, Sector, SectorRow, JobFunction, JobFunctionRow, ProjectTeamMember, FaqCategory, FaqItem, FaqFeedback, ApprovalBoard, ApprovalRecord, ApprovalRate, ApprovalStatus, CsRequest, CsRequestDetail, CsDashboard, CsSettings, CsKind, CsUrgency, NpsPending, NpsOverview, NpsResponse, SupportOptions, SupportOpenResult, DeliveryBoard, DeliveryProjectSummary, DeliveryKind, DeliverySettingsRow, RevisionsOverview, RevisionEntry, SupportTicket, SupportStatus, SupportSettings, SupportTarget, PerfOverview, PerfPersonDetail, PerfHighlights, PerfSettings, AppNotification, AutomationRule, ChangeReason, ClientScheduleChange, AutomationRun, BoardCard, BoardColumn, CatalogService, ClientListItem, ClientRecord, ClientType, EmploymentType, HomeDashboard, Intake, Permissions, Profile,
  ProjectDetail, ProjectListItem, ProjectRole, ProjectSchedule, RecordStatus, ScheduleTask, ScheduleTemplate, ScheduleTrack,
  SchedulePreview, ServiceFamily, StaffMember, StepOption, TaskAlert, TaskChange, TaskDependency, TaskLibraryItem, TaskStatus, TemplateDependency, Tenant,
  TenantOverview, UserRole,
} from "@/types/domain";

export const ADJ_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ADJ_IMAGE_MAX = 8 * 1024 * 1024;
export const APPROVAL_PROOF_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
export const APPROVAL_PROOF_MAX = 10 * 1024 * 1024;
export const DELIVERY_FILE_MAX = 50 * 1024 * 1024;

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
  "id, auth_user_id, tenant_id, name, email, role, employment_type, client_type, status, phone, avatar_url, invited_at, last_seen_at, created_at, sector_id, function_ids, bio";

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
  // ---------- Automações ----------
  async listAutomations(): Promise<AutomationRule[]> {
    const { data, error } = await supabase.from("automation_rules")
      .select("id, name, trigger, conditions, actions, active, run_count, last_run_at, created_at, updated_at")
      .eq("archived", false).order("created_at");
    if (error) throw toUserError(error);
    return data as AutomationRule[];
  },
  async listAutomationRuns(limit = 100): Promise<AutomationRun[]> {
    const { data, error } = await supabase.from("automation_runs")
      .select("id, rule_id, event, project_id, task_id, ok, results, context, created_at, project:projects(id, name, code), rule:automation_rules(name)")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw toUserError(error);
    return data as unknown as AutomationRun[];
  },
  saveAutomation: (id: string | null, payload: { name: string; trigger: string; conditions: unknown; actions: unknown; active?: boolean }) =>
    rpc<string>("automation_save", { p_id: id, p_payload: payload }),
  setAutomationActive: (id: string, active: boolean) => rpc<void>("automation_set_active", { p_id: id, p_active: active }),
  archiveAutomation: (id: string) => rpc<void>("automation_archive", { p_id: id }),

  // ---------- Avisos ----------
  myNotifications: (limit = 30) => rpc<AppNotification[]>("my_notifications", { p_limit: limit }),
  async markNotificationsRead(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids);
    if (error) throw toUserError(error);
  },

  // ---------- Quadro (Kanban) de projetos da unidade ----------
  async loadBoard(): Promise<{ columns: BoardColumn[]; cards: BoardCard[] }> {
    await rpc<void>("board_ensure");
    const [c, k] = await Promise.all([
      supabase.from("project_board_columns").select("id, name, sort_order").eq("active", true).order("sort_order"),
      supabase.from("project_board_cards").select("project_id, column_id, sort_order"),
    ]);
    if (c.error) throw toUserError(c.error);
    if (k.error) throw toUserError(k.error);
    return { columns: c.data as BoardColumn[], cards: (k.data as BoardCard[]).map((x) => ({ ...x, sort_order: Number(x.sort_order) })) };
  },
  boardAddColumn: (name: string) => rpc<string>("board_add_column", { p_name: name }),
  boardRenameColumn: (id: string, name: string) => rpc<void>("board_rename_column", { p_column: id, p_name: name }),
  boardReorderColumns: (ids: string[]) => rpc<void>("board_reorder_columns", { p_ids: ids }),
  boardDeleteColumn: (id: string, moveTo: string, confirm: string) =>
    rpc<{ moved: number }>("board_delete_column", { p_column: id, p_move_to: moveTo, p_confirm: confirm }),
  boardMoveCard: (projectId: string, columnId: string, beforeProjectId: string | null) =>
    rpc<void>("board_move_card", { p_project: projectId, p_column: columnId, p_before: beforeProjectId }),
  async getProject(id: string): Promise<ProjectDetail | null> {
    const { data, error } = await supabase.from("projects")
      .select(`id, code, name, status, client_type, project_type, city, state, address, area_m2, contracted_at, created_at, started_at,
        external_source, external_id, origin_tenant_id, commercial_tenant_id, delivery_tenant_id,
        client:clients(id, tenant_id, name, client_type, email, phone, document, company_name, status),
        origin:tenants!projects_origin_tenant_id_fkey(name),
        commercial:tenants!projects_commercial_tenant_id_fkey(name),
        delivery:tenants!projects_delivery_tenant_id_fkey(name),
        services:project_services(id, status, active, contracted_at, contract_source, responsible_user_id, responsible:profiles!project_services_responsible_user_id_fkey(id, name, avatar_url, employment_type), service:services(id, name, code, leadership_area, family:service_families(name, default_project_role, sort_order))),
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
  /** Sub-etapas de cada serviço do projeto (do cronograma ou do padrão) e quem responde por elas. */
  async projectStepOptions(projectId: string): Promise<StepOption[]> {
    const rows = await rpc<StepOption[]>("project_step_options", { p_project: projectId });
    return (rows ?? []).sort((a, b) => a.service_sort - b.service_sort || a.service_name.localeCompare(b.service_name) || a.task_sort - b.task_sort);
  },
  setStepAssignments: (projectId: string, items: { project_service_id: string; task_code: string; user_id: string }[]) =>
    rpc<{ added: number; removed: number; tasks_updated: number }>("set_step_assignments", { p_project: projectId, p_items: items }),
  allocateProject: (projectId: string, tenantId: string, notes: string) =>
    rpc<void>("allocate_project", { p_project: projectId, p_delivery_tenant: tenantId, p_notes: notes || null }),

  // ---------- Clientes ----------
  /** Clientes da unidade com os dados usados na venda (para preencher sem digitar). */
  async clientsForSale(tenantId: string): Promise<{ id: string; name: string; client_type: ClientType; email: string | null; phone: string | null; document: string | null }[]> {
    const { data, error } = await supabase.from("clients")
      .select("id, name, client_type, email, phone, document")
      .eq("tenant_id", tenantId).eq("status", "ativo").order("name");
    if (error) throw toUserError(error);
    return data as { id: string; name: string; client_type: ClientType; email: string | null; phone: string | null; document: string | null }[];
  },
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

  // ---------- Cronograma ----------
  async getProjectSchedule(projectId: string): Promise<ProjectSchedule> {
    const [tracks, tasks, deps] = await Promise.all([
      supabase.from("project_schedule_tracks")
        .select(`id, project_service_id, status, status_note, planned_start_date, planned_end_date, actual_start_date, actual_end_date, created_at,
          template:schedule_templates(name, version),
          project_service:project_services(id, status, service:services(id, name, code, family:service_families(name, sort_order)))`)
        .eq("project_id", projectId).order("created_at"),
      supabase.from("project_tasks")
        .select("id, schedule_track_id, code, name, description, sequence, duration_type, planned_duration_days, planned_start_date, planned_end_date, actual_start_date, actual_end_date, status, status_changed_at, responsible_user_id, waiting_reason, notes, start_not_before, auto_skipped, client_visible, reopen_count, last_reopened_at")
        .eq("project_id", projectId).order("sequence"),
      supabase.from("task_dependencies")
        .select("id, task_id, depends_on_task_id, dependency_type, lag_days, source, task:project_tasks!task_dependencies_task_id_fkey!inner(project_id)")
        .eq("task.project_id", projectId),
    ]);
    for (const r of [tracks, tasks, deps]) if (r.error) throw toUserError(r.error);
    return {
      tracks: tracks.data as unknown as ScheduleTrack[],
      tasks: tasks.data as unknown as ScheduleTask[],
      dependencies: (deps.data ?? []).map(({ task: _t, ...d }) => d) as unknown as TaskDependency[],
    };
  },
  // ---------- Minhas tarefas ----------
  mySteps: () => rpc<MyStep[]>("my_steps", { p_done_since: null }),
  // Performance do time
  performanceOverview: (month: string | null, tenantId?: string | null) =>
    rpc<PerfOverview>("performance_overview", { p_month: month, p_tenant: tenantId ?? null }),
  performancePerson: (profileId: string, month: string | null) => rpc<PerfPersonDetail>("performance_person", { p_profile: profileId, p_month: month }),
  performanceHighlights: (month: string | null) => rpc<PerfHighlights | null>("performance_highlights", { p_month: month }),
  setProfileSector: (profileId: string, sectorId: string | null) => rpc<void>("set_person_sector", { p_profile: profileId, p_sector: sectorId }),
  // Setores da empresa (cadastro da administração, por unidade)
  async performanceSettings(tenantId: string): Promise<PerfSettings> {
    const { data, error } = await supabase.from("performance_settings")
      .select("tenant_id, weight_delivery, weight_on_time, weight_no_backlog, band_ok, band_great, min_volume, include_assigned_tasks, highlight_includes_pj")
      .eq("tenant_id", tenantId).maybeSingle();
    if (error) throw toUserError(error);
    return (data as PerfSettings | null) ?? { tenant_id: tenantId, weight_delivery: 60, weight_on_time: 30, weight_no_backlog: 10, band_ok: 70, band_great: 90,
      min_volume: 3, include_assigned_tasks: true, highlight_includes_pj: false };
  },
  // Funções da equipe (cadastro da administração) e perfil profissional
  async listJobFunctions(): Promise<JobFunction[]> {
    const { data, error } = await supabase.from("job_functions").select("id, tenant_id, profession, specialty, sort_order")
      .is("archived_at", null).order("sort_order").order("profession");
    if (error) throw toUserError(error);
    return data as JobFunction[];
  },
  jobFunctionList: (tenantId: string) => rpc<JobFunctionRow[]>("job_function_list", { p_tenant: tenantId }),
  jobFunctionSave: (tenantId: string | null, id: string | null, profession: string, specialty: string | null) =>
    rpc<string>("job_function_save", { p_tenant: tenantId, p_id: id, p_profession: profession, p_specialty: specialty }),
  jobFunctionDelete: (id: string) => rpc<number>("job_function_delete", { p_id: id }),
  jobFunctionReorder: (tenantId: string, ids: string[]) => rpc<void>("job_function_reorder", { p_tenant: tenantId, p_ids: ids }),
  setPersonProfile: (profileId: string, functionIds: string[], bio: string | null) =>
    rpc<void>("set_person_profile", { p_profile: profileId, p_functions: functionIds, p_bio: bio }),
  clientProjectTeam: (projectId: string) => rpc<ProjectTeamMember[]>("client_project_team", { p_project: projectId }),
  // NPS: pesquisa do cliente ao concluir um serviço; indicadores para o CS
  npsPending: () => rpc<NpsPending[]>("nps_pending"),
  npsAnswer: (projectServiceId: string, score: number, comment: string | null) =>
    rpc<void>("nps_answer", { p_ps: projectServiceId, p_score: score, p_comment: comment?.trim() || null }),
  npsSkip: (projectServiceId: string, mode: "later" | "never") => rpc<void>("nps_skip", { p_ps: projectServiceId, p_mode: mode }),
  npsOverview: (from: string | null, to: string | null) => rpc<NpsOverview>("nps_overview", { p_tenant: null, p_from: from, p_to: to }),
  npsResponses: (from: string | null, to: string | null) => rpc<NpsResponse[]>("nps_responses_list", { p_tenant: null, p_from: from, p_to: to }),
  // Entregas do projeto e rodadas de revisão (regras validadas no banco)
  projectDeliveries: (projectId: string) => rpc<DeliveryBoard>("project_deliveries", { p_project: projectId }),
  deliveryProjects: () => rpc<DeliveryProjectSummary[]>("delivery_projects"),
  deliveryVersionStart: (projectId: string, projectServiceId: string | null, kind: DeliveryKind, title: string | null, notes: string | null, responsibleId: string | null) =>
    rpc<string>("delivery_version_start", { p_project: projectId, p_ps: projectServiceId, p_kind: kind, p_title: title?.trim() || null, p_notes: notes?.trim() || null, p_responsible: responsibleId }),
  deliveryVersionUpdate: (versionId: string, title: string, notes: string | null, responsibleId: string | null) =>
    rpc<void>("delivery_version_update", { p_version: versionId, p_title: title.trim(), p_notes: notes?.trim() || null, p_responsible: responsibleId }),
  /** Sobe o arquivo para a pasta da versão e registra. Arquivos acima de 50 MB entram como link. */
  async deliveryUpload(projectId: string, versionId: string, f: File): Promise<string> {
    if (f.size > DELIVERY_FILE_MAX) throw new UserFacingError(`“${f.name}” passa de 50 MB. Envie pelo Google Drive e adicione o link.`);
    const ext = (f.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "bin").toLowerCase();
    const path = `${projectId}/${versionId}/${crypto.randomUUID()}.${ext}`;
    const up = await supabase.storage.from("project-deliveries").upload(path, f, { contentType: f.type || "application/octet-stream", cacheControl: "3600" });
    if (up.error) throw new UserFacingError(`Não foi possível enviar “${f.name}”. Tente novamente.`);
    return rpc<string>("delivery_file_add", { p_version: versionId, p_kind: "file", p_name: f.name, p_path: path, p_mime: f.type || null, p_size: f.size, p_url: null });
  },
  deliveryAddLink: (versionId: string, name: string, url: string) =>
    rpc<string>("delivery_file_add", { p_version: versionId, p_kind: "link", p_name: name.trim() || null, p_path: null, p_mime: null, p_size: null, p_url: url.trim() }),
  deliveryFileRemove: (fileId: string) => rpc<void>("delivery_file_remove", { p_file: fileId }),
  deliveryVersionDiscard: (versionId: string) => rpc<void>("delivery_version_discard", { p_version: versionId }),
  deliveryVersionPublish: (versionId: string) => rpc<void>("delivery_version_publish", { p_version: versionId }),
  deliveryFileUrl: async (path: string, download?: string): Promise<string> => {
    const { data, error } = await supabase.storage.from("project-deliveries").createSignedUrl(path, 3600, download ? { download } : undefined);
    if (error || !data) throw new UserFacingError("Não foi possível abrir o arquivo.");
    return data.signedUrl;
  },
  /** Pede (ou registra) a revisão com anexos: prints, referências, inspirações. Os arquivos sobem antes do registro. */
  async deliveryRequestRevision(projectId: string, projectServiceId: string, items: string[], notes: string | null, files: File[] = []): Promise<number> {
    const big = files.find((f) => f.size > DELIVERY_FILE_MAX);
    if (big) throw new UserFacingError(`“${big.name}” passa de 50 MB.`);
    const id = crypto.randomUUID();
    const uploaded: { name: string; path: string; mime: string | null; size: number }[] = [];
    for (const f of files) {
      const ext = (f.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? (f.type.startsWith("image/") ? f.type.slice(6) : "bin")).toLowerCase();
      const path = `${projectId}/req/${id}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("project-deliveries").upload(path, f, { contentType: f.type || "application/octet-stream", cacheControl: "3600" });
      if (up.error) throw new UserFacingError(`Não foi possível enviar “${f.name}”. Tente novamente.`);
      uploaded.push({ name: f.name, path, mime: f.type || null, size: f.size });
    }
    return rpc<number>("delivery_request_revision", { p_project: projectId, p_ps: projectServiceId, p_items: items.map((x) => x.trim()).filter(Boolean),
      p_notes: notes?.trim() || null, p_id: id, p_files: uploaded });
  },
  /** Endereços temporários (1 h) para mostrar miniaturas e abrir anexos. */
  deliveryFileUrls: async (paths: string[]): Promise<Record<string, string>> => {
    if (!paths.length) return {};
    const { data, error } = await supabase.storage.from("project-deliveries").createSignedUrls(paths, 3600);
    if (error || !data) return {};
    return Object.fromEntries(data.filter((x) => x.signedUrl && x.path).map((x) => [x.path as string, x.signedUrl as string]));
  },
  deliveryApprove: (projectId: string, projectServiceId: string, note: string | null) =>
    rpc<void>("delivery_approve", { p_project: projectId, p_ps: projectServiceId, p_note: note?.trim() || null }),
  deliveryExtraRequest: (projectId: string, projectServiceId: string, kind: "courtesy" | "paid", reason: string, amount: number | null) =>
    rpc<string>("delivery_extra_request", { p_project: projectId, p_ps: projectServiceId, p_kind: kind, p_reason: reason.trim(), p_amount: amount }),
  deliveryExtraDecide: (id: string, approve: boolean, note: string | null) =>
    rpc<void>("delivery_extra_decide", { p_id: id, p_approve: approve, p_note: note?.trim() || null }),
  deliverySettings: () => rpc<{ can_edit: boolean; services: DeliverySettingsRow[] }>("delivery_settings_list"),
  deliverySettingsSave: (serviceId: string, enabled: boolean, included: number, codes: string[]) =>
    rpc<void>("delivery_settings_save", { p_service: serviceId, p_enabled: enabled, p_included: included, p_codes: codes }),
  revisionsOverview: (month: string, tenantId: string | null) => rpc<RevisionsOverview>("revisions_overview", { p_month: month, p_tenant: tenantId }),
  revisionsPerson: (profileId: string, month: string) => rpc<RevisionEntry[]>("revisions_person", { p_profile: profileId, p_month: month }),
  // "Preciso de ajuda": cliente fala com o líder certo pelo WhatsApp; o CS acompanha
  supportOptions: () => rpc<SupportOptions>("support_options"),
  supportOpen: (projectId: string, categoryId: string, message: string | null) =>
    rpc<SupportOpenResult>("support_open", { p_project: projectId, p_category: categoryId, p_message: message?.trim() || null }),
  supportTickets: () => rpc<SupportTicket[]>("support_tickets_list"),
  supportTicketUpdate: (id: string, status: SupportStatus, note: string | null) =>
    rpc<void>("support_ticket_update", { p_id: id, p_status: status, p_note: note?.trim() || null }),
  supportSettings: (tenantId: string) => rpc<SupportSettings>("support_settings_get", { p_tenant: tenantId }),
  supportSettingsSave: (tenantId: string, csWhatsapp: string | null, template: string | null) =>
    rpc<void>("support_settings_save", { p_tenant: tenantId, p_cs_whatsapp: csWhatsapp?.trim() || null, p_template: template?.trim() || null }),
  setPersonWhatsapp: (profileId: string, whatsapp: string | null) =>
    rpc<string | null>("set_person_whatsapp", { p_profile: profileId, p_whatsapp: whatsapp?.trim() || null }),
  supportCategorySave: (c: { id: string | null; label: string; description: string | null; target: SupportTarget; active: boolean }) =>
    rpc<string>("support_category_save", { p_id: c.id, p_label: c.label.trim(), p_description: c.description?.trim() || null, p_target: c.target, p_active: c.active }),
  // Customer Success: chamados para a equipe e painel
  csRequests: (scope: "all" | "mine" | "project", projectId?: string | null) =>
    rpc<CsRequest[]>("cs_requests_list", { p_scope: scope, p_project: projectId ?? null }),
  csRequest: (id: string) => rpc<CsRequestDetail>("cs_request_detail", { p_id: id }),
  csCreate: (input: { project_id: string; kind: CsKind; urgency: CsUrgency; title: string; body: string; task_id?: string | null }) =>
    rpc<string>("cs_request_create", { p_project: input.project_id, p_kind: input.kind, p_urgency: input.urgency,
      p_title: input.title.trim(), p_body: input.body.trim(), p_task: input.task_id || null }),
  csReply: (id: string, body: string) => rpc<void>("cs_request_reply", { p_id: id, p_body: body.trim() }),
  csSetStatus: (id: string, status: "resolved" | "cancelled" | "open") => rpc<void>("cs_request_set_status", { p_id: id, p_status: status }),
  csDashboard: () => rpc<CsDashboard>("cs_dashboard"),
  csSettings: (tenantId: string) => rpc<CsSettings>("cs_settings_get", { p_tenant: tenantId }),
  csSettingsSave: (tenantId: string, s: Omit<CsSettings, "tenant_id">) =>
    rpc<void>("cs_settings_save", { p_tenant: tenantId, p_normal_days: s.normal_days, p_high_days: s.high_days, p_urgent_hours: s.urgent_hours }),
  // Aprovações de projeto e comissões (regras validadas no banco)
  projectApprovalBoard: (projectId: string) => rpc<ApprovalBoard>("project_approval_board", { p_project: projectId }),
  /** Envia o comprovante (PDF ou imagem) e registra a aprovação. Reenvio usa o mesmo id. */
  async registerApproval(input: { id?: string; project_id: string; type_id: string; approved_on: string; protocol?: string | null; notes?: string | null; file: File }): Promise<string> {
    const f = input.file;
    if (!APPROVAL_PROOF_TYPES.includes(f.type)) throw new UserFacingError(`“${f.name}”: use PDF ou imagem (JPG, PNG ou WebP).`);
    if (f.size > APPROVAL_PROOF_MAX) throw new UserFacingError(`“${f.name}” passa de 10 MB.`);
    const id = input.id ?? crypto.randomUUID();
    const ext = f.type === "application/pdf" ? "pdf" : f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
    const path = `${input.project_id}/${id}/${crypto.randomUUID()}.${ext}`;
    const up = await supabase.storage.from("approval-proofs").upload(path, f, { contentType: f.type, cacheControl: "3600" });
    if (up.error) throw new UserFacingError(`Não foi possível enviar “${f.name}”. Tente novamente.`);
    return rpc<string>("approval_register", {
      p_id: id, p_project: input.project_id, p_type: input.type_id, p_approved_on: input.approved_on,
      p_protocol: input.protocol?.trim() || null, p_proof: { path, name: f.name, size: f.size, type: f.type }, p_notes: input.notes?.trim() || null,
    });
  },
  approvalReview: (id: string, ok: boolean, note?: string | null) => rpc<void>("approval_review", { p_id: id, p_ok: ok, p_note: note ?? null }),
  approvalSetStatus: (id: string, status: ApprovalStatus, note?: string | null) => rpc<void>("approval_set_status", { p_id: id, p_status: status, p_note: note ?? null }),
  approvalUpdate: (id: string, amount: number | null, recipientId: string | null) => rpc<void>("approval_update", { p_id: id, p_amount: amount, p_recipient: recipientId }),
  approvalsList: (tenantId: string | null) => rpc<ApprovalRecord[]>("approvals_list", { p_tenant: tenantId }),
  approvalRatesList: (tenantId: string) => rpc<ApprovalRate[]>("approval_rates_list", { p_tenant: tenantId }),
  approvalRateSave: (tenantId: string, typeId: string, amount: number) => rpc<void>("approval_rate_save", { p_tenant: tenantId, p_type: typeId, p_amount: amount }),
  includeTramite: (projectId: string, serviceId: string) => rpc<{ tracks_created?: number }>("approval_include_tramite", { p_project: projectId, p_service: serviceId }),
  /** Link temporário (1 h) para abrir o comprovante privado. */
  async approvalProofUrl(path: string): Promise<string> {
    const { data, error } = await supabase.storage.from("approval-proofs").createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) throw new UserFacingError("Não foi possível abrir o comprovante.");
    return data.signedUrl;
  },
  // Dúvidas frequentes: leitura para todos; edição só da administração global (validado no banco)
  async listFaq(): Promise<{ categories: FaqCategory[]; items: FaqItem[] }> {
    const [c, i] = await Promise.all([
      supabase.from("faq_categories").select("id, title, sort_order").is("archived_at", null).order("sort_order"),
      supabase.from("faq_items").select("id, category_id, question, answer, keywords, sort_order, updated_at").is("archived_at", null).order("sort_order"),
    ]);
    if (c.error) throw toUserError(c.error);
    if (i.error) throw toUserError(i.error);
    return { categories: c.data as FaqCategory[], items: i.data as FaqItem[] };
  },
  faqCategorySave: (id: string | null, title: string) => rpc<string>("faq_category_save", { p_id: id, p_title: title }),
  faqCategoryArchive: (id: string) => rpc<void>("faq_category_archive", { p_id: id }),
  faqItemSave: (input: { id: string | null; category_id: string; question: string; answer: string; keywords: string | null }) =>
    rpc<string>("faq_item_save", { p_id: input.id, p_category: input.category_id, p_question: input.question, p_answer: input.answer, p_keywords: input.keywords }),
  faqItemArchive: (id: string) => rpc<void>("faq_item_archive", { p_id: id }),
  faqFeedback: (itemId: string | null, helpful: boolean, query: string | null) =>
    rpc<void>("faq_feedback_add", { p_item: itemId, p_helpful: helpful, p_query: query }),
  async listFaqFeedback(limit = 200): Promise<FaqFeedback[]> {
    const { data, error } = await supabase.from("faq_feedback").select("id, item_id, helpful, query, created_at")
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw toUserError(error);
    return data as FaqFeedback[];
  },
  sectorList: (tenantId: string) => rpc<SectorRow[]>("sector_list", { p_tenant: tenantId }),
  sectorSave: (tenantId: string | null, id: string | null, name: string) => rpc<string>("sector_save", { p_tenant: tenantId, p_id: id, p_name: name }),
  sectorDelete: (id: string) => rpc<number>("sector_delete", { p_id: id }),
  sectorReorder: (tenantId: string, ids: string[]) => rpc<void>("sector_reorder", { p_tenant: tenantId, p_ids: ids }),
  savePerformanceSettings: (tenantId: string, s: Omit<PerfSettings, "tenant_id">) => rpc<PerfSettings>("save_performance_settings", { p_tenant: tenantId, p: s }),
  /** Minhas tarefas do dia (pessoais e atribuídas pela liderança). */
  listWorkItems: () => rpc<WorkItem[]>("my_work_items"),
  /** Tarefas atribuídas que eu acompanho como liderança. */
  teamWorkItems: (since?: string | null) => rpc<WorkItem[]>("team_work_items", { p_since: since ?? null }),
  assignablePeople: () => rpc<TeamPerson[]>("assignable_people"),
  assignWorkItems: (input: { owners: string[]; title: string; due_date: string; description?: string | null; task_id?: string | null; project_id?: string | null }) =>
    rpc<number>("assign_work_items", { p_owners: input.owners, p_title: input.title.trim(), p_due: input.due_date,
      p_description: input.description?.trim() || null, p_task: input.task_id || null, p_project: input.project_id || null }),
  async addWorkItem(input: { title: string; due_date: string; project_task_id?: string | null }): Promise<WorkItem> {
    const { data, error } = await supabase.from("work_items")
      .insert({ title: input.title.trim(), due_date: input.due_date, project_task_id: input.project_task_id || null })
      .select("id, title, due_date, done_at, project_task_id, project_id, created_at").single();
    if (error) throw toUserError(error);
    return data as WorkItem;
  },
  async updateWorkItem(id: string, patch: Partial<Pick<WorkItem, "title" | "description" | "due_date" | "done_at" | "project_task_id" | "project_id"> & { owner_id: string }>): Promise<void> {
    const { error } = await supabase.from("work_items").update(patch).eq("id", id);
    if (error) throw toUserError(error);
  },
  async deleteWorkItem(id: string): Promise<void> {
    const { error } = await supabase.from("work_items").delete().eq("id", id);
    if (error) throw toUserError(error);
  },
  async taskNotes(taskId: string): Promise<TaskNote[]> {
    const { data, error } = await supabase.from("task_notes")
      .select("id, body, created_at, author:profiles!task_notes_author_id_fkey(name)")
      .eq("task_id", taskId).order("created_at", { ascending: false }).limit(100);
    if (error) throw toUserError(error);
    return data as unknown as TaskNote[];
  },
  addTaskNote: (taskId: string, body: string) => rpc<string>("add_task_note", { p_task: taskId, p_body: body }),
  async taskHistory(taskId: string): Promise<TaskChange[]> {
    const { data, error } = await supabase.from("task_changes")
      .select("id, task_id, change_type, before, after, reason, impacted_task_ids, created_at, author:profiles!task_changes_changed_by_fkey(name)")
      .eq("task_id", taskId).order("created_at", { ascending: false }).limit(50);
    if (error) throw toUserError(error);
    return data as unknown as TaskChange[];
  },
  /** Etapas abertas de todos os projetos visíveis (view com alertas calculados). */
  async openTaskAlerts(): Promise<TaskAlert[]> {
    const { data, error } = await supabase.from("task_alerts")
      .select("*").not("status", "in", "(completed,cancelled)").order("planned_end_date", { ascending: true, nullsFirst: false }).limit(500);
    if (error) throw toUserError(error);
    return data as TaskAlert[];
  },
  async saveTaskNotes(taskId: string, notes: string): Promise<void> {
    const { error } = await supabase.from("project_tasks").update({ notes: notes.trim() || null }).eq("id", taskId);
    if (error) throw toUserError(error);
  },
  generateSchedule: (projectId: string) => rpc<{ tracks_created: number; tasks_created: number; tracks_pending: number }>("generate_project_schedule", { p_project: projectId }),
  setProjectArea: (projectId: string, area: number) => rpc<{ tasks_created: number }>("set_project_area", { p_project: projectId, p_area: area }),
  activateProjectService: (id: string) => rpc<{ tracks_created?: number }>("activate_project_service", { p_project_service: id }),
  previewTaskChange: (taskId: string, start: string | null, duration: number | null) =>
    rpc<SchedulePreview>("preview_task_change", { p_task: taskId, p_start: start, p_duration: duration }),
  rescheduleTask: (taskId: string, start: string | null, duration: number | null, reason: string) =>
    rpc<{ impacted_count: number }>("reschedule_task", { p_task: taskId, p_start: start, p_duration: duration, p_reason: reason }),
  /** Reprograma com motivo da lista; "Outro motivo" exige texto, nos demais o texto é uma observação opcional. */
  rescheduleTaskWithReason: (taskId: string, start: string | null, duration: number | null, reasonId: string, reasonText: string | null) =>
    rpc<{ impacted_count: number }>("reschedule_task_with_reason", {
      p_task: taskId, p_start: start, p_duration: duration, p_reason_id: reasonId, p_reason_text: reasonText?.trim() || null,
    }),
  /** Prévia da reabertura: aplica, mede o impacto e desfaz. */
  previewTaskReopen: (taskId: string, start: string | null, days: number) =>
    rpc<SchedulePreview>("preview_task_reopen", { p_task: taskId, p_start: start, p_days: days }),
  reopenTask: (taskId: string, start: string | null, days: number, reasonId: string, reasonText: string | null) =>
    rpc<{ impacted_count: number }>("reopen_task", {
      p_task: taskId, p_start: start, p_days: days, p_reason_id: reasonId, p_reason_text: reasonText?.trim() || null,
    }),
  clientScheduleChanges: (projectId?: string | null, limit = 50) =>
    rpc<ClientScheduleChange[]>("client_schedule_changes", { p_project: projectId ?? null, p_limit: limit }),
  setTaskStatus: (taskId: string, status: TaskStatus, reason?: string | null) =>
    rpc<{ impacted_count: number; status: TaskStatus }>("set_task_status", { p_task: taskId, p_status: status, p_reason: reason ?? null }),
  setTaskResponsible: (taskId: string, userId: string | null) => rpc<void>("set_task_responsible", { p_task: taskId, p_user: userId }),
  addTaskDependency: (taskId: string, dependsOn: string, reason: string) =>
    rpc<{ impacted_count: number }>("add_task_dependency", { p_task: taskId, p_depends_on: dependsOn, p_reason: reason }),
  removeTaskDependency: (taskId: string, dependsOn: string, reason: string) =>
    rpc<{ impacted_count: number }>("remove_task_dependency", { p_task: taskId, p_depends_on: dependsOn, p_reason: reason }),

  addProjectTask: (input: { track_id: string; after_id: string | null; name: string; description?: string | null; duration: number | null;
    duration_type: "fixed" | "external" | "ongoing"; responsible_id: string | null; in_sequence: boolean; reason: string; save_to_library: boolean }) =>
    rpc<{ task_id: string; impacted_count: number }>("add_project_task", {
      p_track: input.track_id, p_after: input.after_id, p_name: input.name, p_description: input.description ?? null,
      p_duration: input.duration, p_duration_type: input.duration_type, p_responsible: input.responsible_id,
      p_in_sequence: input.in_sequence, p_reason: input.reason, p_save_to_library: input.save_to_library,
    }),

  // ---------- Biblioteca de etapas ----------
  async listTaskLibrary(includeInactive = false): Promise<TaskLibraryItem[]> {
    let q = supabase.from("task_library").select("id, name, description, family_id, default_duration_days, duration_type, active, created_by, created_at, sort_order").order("sort_order", { ascending: true, nullsFirst: false }).order("name");
    if (!includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    if (error) throw toUserError(error);
    return data as TaskLibraryItem[];
  },
  async saveTaskLibraryItem(input: { id?: string; name: string; description?: string | null; family_id?: string | null;
    default_duration_days?: number | null; duration_type: "fixed" | "external" | "ongoing"; active?: boolean; created_by?: string | null }): Promise<void> {
    const row = {
      name: input.name.trim(), description: input.description?.trim() || null, family_id: input.family_id || null,
      duration_type: input.duration_type, default_duration_days: input.duration_type === "fixed" ? input.default_duration_days ?? null : null,
      ...(input.active === undefined ? {} : { active: input.active }),
    };
    const { error } = input.id
      ? await supabase.from("task_library").update(row).eq("id", input.id)
      : await supabase.from("task_library").insert({ ...row, created_by: input.created_by ?? null });
    if (error) {
      if (error.code === "23505") throw new UserFacingError("Já existe uma etapa com este nome na biblioteca.");
      throw toUserError(error);
    }
  },

  /** Registra uma etapa nova na biblioteca e devolve o item (usado pelo seletor de etapas). */
  async createTaskLibraryItem(input: { name: string; duration_type: "fixed" | "external" | "ongoing"; default_duration_days?: number | null; created_by?: string | null }): Promise<TaskLibraryItem> {
    const { data, error } = await supabase.from("task_library").insert({
      name: input.name.trim(), duration_type: input.duration_type, created_by: input.created_by ?? null,
      default_duration_days: input.duration_type === "fixed" ? input.default_duration_days ?? null : null,
    }).select("id, name, description, family_id, default_duration_days, duration_type, active, created_by, created_at, sort_order").single();
    if (error) {
      if (error.code === "23505") throw new UserFacingError("Já existe uma etapa com este nome na biblioteca (talvez entre as excluídas).");
      throw toUserError(error);
    }
    return data as TaskLibraryItem;
  },

  // ---------- Ajustes entre setores ----------
  async listAdjustmentComplexities(): Promise<AdjustmentComplexity[]> {
    const { data, error } = await supabase.from("adjustment_complexities").select("code, label, default_days, description, sort_order").order("sort_order");
    if (error) throw toUserError(error);
    return data as AdjustmentComplexity[];
  },
  async saveAdjustmentComplexity(input: Pick<AdjustmentComplexity, "code" | "label" | "default_days" | "description">): Promise<void> {
    const { error } = await supabase.from("adjustment_complexities")
      .update({ label: input.label.trim(), default_days: input.default_days, description: input.description?.trim() || null })
      .eq("code", input.code);
    if (error) throw toUserError(error);
  },
  projectAdjustments: (projectId: string) => rpc<AdjustmentRequest[]>("project_adjustments", { p_project: projectId }),
  myPendingAdjustments: () => rpc<AdjustmentRequest[]>("my_pending_adjustments"),
  createAdjustment: (input: { taskId: string; complexity: string; description: string; days?: number | null; fromService?: string | null }) =>
    rpc<string>("adjustment_create", { p_task: input.taskId, p_complexity: input.complexity, p_description: input.description,
      p_days: input.days ?? null, p_from_service: input.fromService || null }),
  decideAdjustment: (input: { id: string; approve: boolean; note?: string | null; days?: number | null; assignee?: string | null; start?: string | null }) =>
    rpc<{ status: string; impacted_count?: number }>("adjustment_decide", { p_request: input.id, p_approve: input.approve,
      p_note: input.note?.trim() || null, p_days: input.days ?? null, p_assignee: input.assignee ?? null, p_start: input.start || null }),
  cancelAdjustment: (id: string) => rpc<void>("adjustment_cancel", { p_request: id }),
  /** Envia as imagens do pedido (bucket privado) e registra no pedido. */
  async uploadAdjustmentImages(projectId: string, requestId: string, files: File[]): Promise<void> {
    const saved: AdjustmentAttachment[] = [];
    for (const f of files) {
      if (!ADJ_IMAGE_TYPES.includes(f.type)) throw new UserFacingError(`“${f.name}” não é JPG, PNG ou WebP.`);
      if (f.size > ADJ_IMAGE_MAX) throw new UserFacingError(`“${f.name}” passa de 8 MB.`);
      const ext = f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
      const path = `${projectId}/${requestId}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from("adjustment-files").upload(path, f, { contentType: f.type, cacheControl: "3600" });
      if (up.error) throw new UserFacingError(`Não foi possível enviar “${f.name}”. Tente novamente.`);
      saved.push({ path, name: f.name, size: f.size, type: f.type });
    }
    await rpc<void>("adjustment_set_attachments", { p_request: requestId, p_files: saved });
  },
  /** Links temporários (1 h) para ver as imagens privadas. */
  async adjustmentImageUrls(paths: string[]): Promise<Record<string, string>> {
    if (paths.length === 0) return {};
    const { data, error } = await supabase.storage.from("adjustment-files").createSignedUrls(paths, 3600);
    if (error) throw new UserFacingError("Não foi possível carregar as imagens.");
    return Object.fromEntries((data ?? []).filter((x) => x.signedUrl).map((x) => [x.path as string, x.signedUrl as string]));
  },

  // ---------- Motivos de alteração de prazo ----------
  async listChangeReasons(includeInactive = false, kind?: ReasonKind): Promise<ChangeReason[]> {
    let q = supabase.from("schedule_change_reasons").select("id, kind, label, description, client_visible, is_other, sort_order, active")
      .order("sort_order").order("label");
    if (!includeInactive) q = q.eq("active", true);
    if (kind) q = q.eq("kind", kind);
    const { data, error } = await q;
    if (error) throw toUserError(error);
    return data as ChangeReason[];
  },
  async saveChangeReason(input: { id?: string; kind?: ReasonKind; label: string; client_visible: boolean; active?: boolean; sort_order?: number; created_by?: string | null }): Promise<void> {
    const row = {
      label: input.label.trim(), client_visible: input.client_visible,
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.sort_order === undefined ? {} : { sort_order: input.sort_order }),
    };
    const { error } = input.id
      ? await supabase.from("schedule_change_reasons").update(row).eq("id", input.id)
      : await supabase.from("schedule_change_reasons").insert({ ...row, kind: input.kind ?? "schedule", created_by: input.created_by ?? null });
    if (error) {
      if (error.code === "23505") throw new UserFacingError("Já existe um motivo com este nome (talvez entre os desativados).");
      throw toUserError(error);
    }
  },

  // ---------- Tipos de projeto ----------
  async listProjectTypes(includeInactive = false): Promise<ProjectType[]> {
    let q = supabase.from("project_types").select("id, name, sort_order, active").order("sort_order").order("name");
    if (!includeInactive) q = q.eq("active", true);
    const { data, error } = await q;
    if (error) throw toUserError(error);
    return data as ProjectType[];
  },
  async saveProjectType(input: { id?: string; name: string; active?: boolean }): Promise<ProjectType> {
    const row = { name: input.name.trim(), ...(input.active === undefined ? {} : { active: input.active }) };
    const res = input.id
      ? await supabase.from("project_types").update(row).eq("id", input.id).select("id, name, sort_order, active").single()
      : await supabase.from("project_types").insert(row).select("id, name, sort_order, active").single();
    if (res.error) {
      if (res.error.code === "23505") throw new UserFacingError("Este tipo de projeto já existe (talvez entre os desativados).");
      throw toUserError(res.error);
    }
    return res.data as ProjectType;
  },

  /** Serviços do catálogo (por família) e pacotes, para escolher na venda. */
  async saleServiceOptions(): Promise<SaleServiceOption[]> {
    const [svc, pkg] = await Promise.all([
      supabase.from("services").select("name, aliases, sort_order, family:service_families(name, sort_order)").eq("active", true).order("sort_order"),
      supabase.from("service_packages").select("name, aliases, description").eq("active", true).order("name"),
    ]);
    if (svc.error) throw toUserError(svc.error);
    if (pkg.error) throw toUserError(pkg.error);
    type Row = { name: string; aliases: string[] | null; sort_order: number; family: { name: string; sort_order: number } | null };
    const services = (svc.data as unknown as Row[])
      .sort((a, b) => (a.family?.sort_order ?? 999) - (b.family?.sort_order ?? 999) || a.sort_order - b.sort_order)
      .map((r) => ({ name: r.name, group: r.family?.name ?? "Outros", aliases: r.aliases ?? [], kind: "service" as const }));
    const packages = (pkg.data ?? []).map((r) => ({ name: r.name as string, group: "Pacotes", aliases: (r.aliases as string[]) ?? [], kind: "package" as const, description: r.description as string | null }));
    return [...services, ...packages];
  },

  // ---------- Foto de perfil ----------
  async uploadAvatar(profileId: string, file: File): Promise<string> {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new UserFacingError("Use uma imagem JPG, PNG ou WebP.");
    if (file.size > 2 * 1024 * 1024) throw new UserFacingError("A foto deve ter até 2 MB.");
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${profileId}/foto.${ext}`;
    const up = await supabase.storage.from("avatars").upload(path, file, { upsert: true, contentType: file.type, cacheControl: "3600" });
    if (up.error) throw new UserFacingError("Não foi possível enviar a foto. Tente novamente.");
    const url = `${supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
    await rpc<void>("set_profile_avatar", { p_profile: profileId, p_url: url });
    return url;
  },
  reorderTaskLibrary: (ids: string[]) => rpc<void>("reorder_task_library", { p_ids: ids }),
  /** Setores visíveis (da minha unidade; ADM global vê todas). Filtre por tenant_id da pessoa. */
  async listSectors(): Promise<Sector[]> {
    const { data, error } = await supabase.from("sectors").select("id, tenant_id, name, sort_order").is("archived_at", null).order("sort_order").order("name");
    if (error) throw toUserError(error);
    return data as Sector[];
  },
  removeAvatar: (profileId: string) => rpc<void>("set_profile_avatar", { p_profile: profileId, p_url: null }),

  // ---------- Serviços e templates ----------
  async listCatalog(): Promise<{ families: ServiceFamily[]; services: CatalogService[] }> {
    const [f, s] = await Promise.all([
      supabase.from("service_families").select("id, code, name, sort_order, active").order("sort_order"),
      supabase.from("services").select("id, family_id, code, name, description, available_for_b2c, available_for_b2b, has_schedule_template, requires_area_rule, sort_order, active, aliases, leadership_area").order("sort_order"),
    ]);
    if (f.error) throw toUserError(f.error);
    if (s.error) throw toUserError(s.error);
    return { families: f.data as ServiceFamily[], services: s.data as CatalogService[] };
  },
  async listTemplates(serviceId: string): Promise<ScheduleTemplate[]> {
    const { data, error } = await supabase.from("schedule_templates")
      .select("id, service_id, name, version, client_type, area_min, area_max, status, active, notes, published_at, created_at, tasks:template_tasks(id, template_id, code, name, description, sort_order, default_duration_days, duration_type, include_if_service_codes, client_visible, active)")
      .eq("service_id", serviceId).order("version", { ascending: false });
    if (error) throw toUserError(error);
    // Rascunhos descartados ficam arquivados sem publicação: não aparecem como versão.
    const list = (data as unknown as ScheduleTemplate[]).filter((t) => !(t.status === "archived" && !t.published_at));
    list.forEach((t) => { t.tasks = t.tasks.filter((x) => x.active).sort((a, b) => a.sort_order - b.sort_order); });
    return list;
  },
  async templateDependencies(templateId: string): Promise<TemplateDependency[]> {
    const { data, error } = await supabase.from("template_task_dependencies")
      .select("id, template_task_id, predecessor_task_id, predecessor_service_code, predecessor_task_code, task:template_tasks!template_task_dependencies_template_task_id_fkey!inner(template_id)")
      .eq("task.template_id", templateId).eq("active", true);
    if (error) throw toUserError(error);
    return (data ?? []).map(({ task: _t, ...d }) => d) as unknown as TemplateDependency[];
  },
  /** Etapas dos templates vigentes de todos os serviços (para dependências entre serviços). */
  async activeTemplateTasks(): Promise<{ service_code: string; service_name: string; code: string; name: string }[]> {
    const { data, error } = await supabase.from("template_tasks")
      .select("code, name, sort_order, template:schedule_templates!inner(active, service:services(code, name))")
      .eq("template.active", true).order("sort_order");
    if (error) throw toUserError(error);
    const seen = new Set<string>();
    const out: { service_code: string; service_name: string; code: string; name: string }[] = [];
    for (const r of (data ?? []) as unknown as { code: string; name: string; template: { service: { code: string; name: string } | null } }[]) {
      const sc = r.template.service?.code;
      if (!sc || seen.has(`${sc}.${r.code}`)) continue;
      seen.add(`${sc}.${r.code}`);
      out.push({ service_code: sc, service_name: r.template.service!.name, code: r.code, name: r.name });
    }
    return out;
  },
  async updateService(id: string, patch: Partial<Pick<CatalogService, "available_for_b2c" | "available_for_b2b" | "requires_area_rule" | "description" | "aliases" | "active" | "leadership_area">>): Promise<void> {
    const { error } = await supabase.from("services").update(patch).eq("id", id);
    if (error) throw toUserError(error);
  },
  createTemplateDraft: (input: { service_id?: string | null; from?: string | null; client_type?: ClientType | null; area_min?: number | null; area_max?: number | null; name?: string | null }) =>
    rpc<string>("create_template_draft", {
      p_service: input.service_id ?? null, p_from: input.from ?? null, p_client_type: input.client_type ?? null,
      p_area_min: input.area_min ?? null, p_area_max: input.area_max ?? null, p_name: input.name ?? null,
    }),
  saveTemplateDraft: (templateId: string, name: string, tasks: unknown[]) =>
    rpc<void>("save_template_draft", { p_template: templateId, p_name: name, p_tasks: tasks }),
  publishTemplate: (templateId: string, notes: string) => rpc<void>("publish_template", { p_template: templateId, p_notes: notes || null }),
  discardTemplateDraft: (templateId: string) => rpc<void>("discard_template_draft", { p_template: templateId }),
  /** Situação de cada template (para o navegador de serviços). */
  async templateSummaries(): Promise<Pick<ScheduleTemplate, "id" | "service_id" | "status" | "active" | "version" | "client_type" | "area_min" | "area_max" | "published_at">[]> {
    const { data, error } = await supabase.from("schedule_templates")
      .select("id, service_id, status, active, version, client_type, area_min, area_max, published_at");
    if (error) throw toUserError(error);
    return (data ?? []).filter((t) => !(t.status === "archived" && !t.published_at)) as never;
  },
  templateUsage: (serviceId: string) => rpc<{ template_id: string; projects_in_progress: number }[]>("template_usage", { p_service: serviceId }),
  deleteTemplateVariant: (templateId: string, confirm: string) =>
    rpc<{ archived: number; projects_in_progress: number }>("delete_template_variant", { p_template: templateId, p_confirm: confirm }),
  async setTaskLibraryActive(id: string, active: boolean): Promise<void> {
    const { error } = await supabase.from("task_library").update({ active }).eq("id", id);
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
