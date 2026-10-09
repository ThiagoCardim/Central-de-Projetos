// Tipos de domínio espelhando o schema do banco (supabase/migrations).

export type UserRole = "client" | "collaborator" | "customer_success" | "leader" | "unit_admin" | "global_admin";
export type EmploymentType = "clt" | "pj";
export type ClientType = "b2c" | "b2b";
export type RecordStatus = "ativo" | "inativo";
export type TenantType = "franqueadora" | "franquia";

export type ProjectStatus =
  | "awaiting_allocation" | "awaiting_team_assignment" | "in_progress" | "on_hold" | "completed" | "cancelled";

export type TaskStatus =
  | "not_started" | "waiting_dependency" | "ready" | "in_progress" | "waiting_client"
  | "waiting_third_party" | "completed" | "overdue" | "cancelled";

export type TrackStatus = "no_template" | "awaiting_area" | "planned" | "in_progress" | "completed" | "cancelled";

export interface Tenant {
  id: string;
  name: string;
  type: TenantType;
  status: RecordStatus;
  parent_tenant_id: string | null;
  slug: string | null;
  city: string | null;
  state: string | null;
  created_at: string;
}

export interface Profile {
  id: string;
  auth_user_id: string | null;
  tenant_id: string;
  name: string;
  email: string;
  role: UserRole;
  employment_type: EmploymentType | null;
  client_type: ClientType | null;
  status: RecordStatus;
  phone: string | null;
  avatar_url: string | null;
  invited_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  /** Setor da empresa (cadastro da administração), usado na performance do time. */
  sector_id?: string | null;
  /** Funções (Profissão › Especialidade) e descrição que aparecem para o cliente. */
  function_ids?: string[];
  bio?: string | null;
}

export interface ClientRecord {
  id: string;
  tenant_id: string;
  name: string;
  client_type: ClientType;
  email: string | null;
  status: RecordStatus;
}

/** Retorno de public.my_permissions() — usado só para exibir/ocultar UI. */
export interface Permissions {
  profile_id: string;
  tenant_id: string;
  role: UserRole;
  employment_type: EmploymentType | null;
  client_type: ClientType | null;
  can_manage_users: boolean;
  can_manage_tenant: boolean;
  can_manage_tenants: boolean;
  can_manage_templates: boolean;
  can_distribute: boolean;
  can_view_intake: boolean;
  can_view_performance: boolean;
  can_view_approvals?: boolean;
  can_admin_approvals?: boolean;
  is_cs?: boolean;
  is_manager: boolean;
  is_staff: boolean;
}

export interface TenantOverview {
  tenant_id: string;
  name: string;
  type: TenantType;
  status: RecordStatus;
  city: string | null;
  state: string | null;
  users_active: number;
  users_inactive: number;
  collaborators_clt: number;
  collaborators_pj: number;
  clients: number;
  projects_active: number;
  projects_awaiting: number;
  created_at: string;
}

/** Linha de public.task_alerts. */
export interface TaskAlert {
  task_id: string;
  project_id: string;
  task_name: string;
  status: TaskStatus;
  responsible_user_id: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  project_name: string;
  project_code: string | null;
  service_name: string;
  due_in_days: number | null;
  overdue_days: number | null;
  waiting_days: number | null;
  is_overdue: boolean;
  is_blocked: boolean;
  is_waiting_client: boolean;
  is_unassigned: boolean;
}

export interface AwaitingTeamProject {
  id: string;
  code: string | null;
  name: string;
  project_type: string | null;
  client_type: ClientType;
  client_name: string;
  city: string | null;
  state: string | null;
  contracted_at: string | null;
  services: string[];
}

export interface ClientStep {
  name: string;
  status: TaskStatus;
  planned_end_date: string | null;
  actual_end_date: string | null;
}

export interface ClientService {
  name: string;
  track_status: TrackStatus;
  progress: number;
  current_step: { name: string; status: TaskStatus; planned_end_date: string | null } | null;
  next_step: { name: string; planned_start_date: string | null } | null;
  planned_end_date: string | null;
  steps: ClientStep[];
}

export interface ClientProject {
  id: string;
  code: string | null;
  name: string;
  status: ProjectStatus;
  city: string | null;
  state: string | null;
  contracted_at: string | null;
  forecast_end: string | null;
  progress: number;
  pending_from_client: number;
  services: ClientService[];
}

/** Retorno de public.get_home_dashboard(). Blocos presentes conforme o perfil. */
export interface HomeDashboard {
  me: {
    id: string;
    name: string;
    role: UserRole;
    employment_type: EmploymentType | null;
    client_type: ClientType | null;
    tenant: { id: string; name: string; type: TenantType };
  };
  generated_at: string;
  client?: { projects: ClientProject[] };
  my_work?: {
    counts: { open: number; overdue: number; due_today: number; due_next_7: number; waiting_client: number; blocked: number };
    tasks: TaskAlert[];
    projects: { id: string; code: string | null; name: string; status: ProjectStatus; project_role: string }[];
  };
  operations?: {
    counts: {
      projects_active: number; awaiting_team: number; awaiting_allocation: number;
      tasks_overdue: number; tasks_blocked: number; tasks_waiting_client: number; tasks_unassigned: number;
      due_next_7: number; projects_at_risk: number; services_pending_review: number;
    };
    awaiting_team: AwaitingTeamProject[];
    alerts: TaskAlert[];
    team_load: { id: string; name: string; open: number; overdue: number }[];
  };
  admin?: {
    users: { active: number; inactive: number; clt: number; pj: number; clients: number; pending_invite: number };
    intake: { received: number; errors: number; last_24h: number };
    tenants: TenantOverview[] | null;
  };
}

/* ==========================================================================
   Etapa 2 — Entrada, projetos, distribuição e equipe
   ========================================================================== */
export type IntakeStatus = "received" | "validated" | "processing" | "processed" | "error" | "ignored";
export type IntakeKind = "new_project" | "additional_service";
export type ProjectServiceStatus = "pending_review" | "active" | "completed" | "cancelled";

export interface Intake {
  id: string;
  source: string;
  external_id: string;
  intake_kind: IntakeKind;
  target_external_id: string | null;
  client_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  client_document: string | null;
  client_type: ClientType | null;
  project_name: string | null;
  project_type: string | null;
  services: string[];
  resolved_services: { service_id: string; name: string; input: string; package_id: string | null }[] | null;
  contracted_at: string | null;
  contract_value: number | null;
  area_m2: number | null;
  city: string | null;
  state: string | null;
  address: string | null;
  salesperson: string | null;
  notes: string | null;
  status: IntakeStatus;
  validation_error: string | null;
  validation_details: { errors?: string[]; warnings?: string[]; unknown_services?: string[] } | null;
  received_at: string;
  processed_at: string | null;
  created_project_id: string | null;
  raw_payload: unknown;
}

export interface ProjectListItem {
  id: string;
  code: string | null;
  name: string;
  status: ProjectStatus;
  client_type: ClientType;
  project_type: string | null;
  city: string | null;
  state: string | null;
  contracted_at: string | null;
  created_at: string;
  delivery_tenant_id: string | null;
  client: { id: string; name: string } | null;
  delivery: { name: string } | null;
  services: { id: string; status: ProjectServiceStatus; active: boolean; service: { name: string } | null }[];
}

export interface BoardColumn { id: string; name: string; sort_order: number }
export interface BoardCard { project_id: string; column_id: string; sort_order: number }

export interface ProjectRole { code: string; name: string; sort_order: number; required: boolean }

export interface ProjectDetail extends Omit<ProjectListItem, "services" | "client"> {
  address: string | null;
  area_m2: number | null;
  started_at: string | null;
  external_source: string | null;
  external_id: string | null;
  origin_tenant_id: string | null;
  commercial_tenant_id: string;
  client: (ClientRecord & { phone: string | null; document: string | null; company_name: string | null }) | null;
  origin: { name: string } | null;
  commercial: { name: string } | null;
  services: {
    id: string; status: ProjectServiceStatus; active: boolean; contracted_at: string | null; contract_source: string | null;
    responsible_user_id: string | null;
    responsible: { id: string; name: string; avatar_url: string | null; employment_type: EmploymentType | null } | null;
    service: { id: string; name: string; code: string; leadership_area?: LeadershipArea; family: { name: string; default_project_role: string | null; sort_order?: number } | null } | null;
  }[];
  team: {
    id: string; project_role: string; employment_type: EmploymentType | null; active: boolean; assigned_at: string;
    user: { id: string; name: string; avatar_url: string | null; employment_type: EmploymentType | null } | null;
  }[];
  allocations: {
    id: string; allocation_method: string; allocation_status: string; allocated_at: string | null; notes: string | null;
    created_at: string; delivery: { name: string } | null;
  }[];
}

export interface StaffMember {
  id: string; name: string; role: UserRole; employment_type: EmploymentType | null; avatar_url: string | null; tenant_id: string;
}

export interface ClientListItem extends ClientRecord {
  phone: string | null;
  document: string | null;
  company_name: string | null;
  created_at: string;
  projects: { count: number }[];
}

/* ==========================================================================
   Etapa 3 — Cronograma modular e templates
   ========================================================================== */
export type DurationType = "fixed" | "dependent" | "external" | "ongoing";
export type DependencyType = "finish_to_start" | "start_to_start" | "finish_to_finish";
export type TemplateStatus = "draft" | "published" | "archived";

export interface ScheduleTrack {
  id: string;
  project_service_id: string;
  status: TrackStatus;
  status_note: string | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  created_at: string;
  template: { name: string; version: number } | null;
  project_service: {
    id: string; status: ProjectServiceStatus;
    service: { id: string; name: string; code: string; family: { name: string; sort_order: number } | null } | null;
  } | null;
}

export interface ScheduleTask {
  id: string;
  schedule_track_id: string;
  code: string | null;
  name: string;
  description: string | null;
  sequence: number;
  duration_type: DurationType;
  planned_duration_days: number | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  actual_start_date: string | null;
  actual_end_date: string | null;
  status: TaskStatus;
  status_changed_at: string;
  responsible_user_id: string | null;
  waiting_reason: string | null;
  notes: string | null;
  start_not_before: string | null;
  auto_skipped: boolean;
  client_visible: boolean;
  /** Quantas vezes a etapa foi reaberta depois de concluída. */
  reopen_count?: number;
  last_reopened_at?: string | null;
}

export interface TaskDependency {
  id: string;
  task_id: string;
  depends_on_task_id: string;
  dependency_type: DependencyType;
  lag_days: number;
  source: "template" | "manual";
}

export interface ProjectSchedule {
  tracks: ScheduleTrack[];
  tasks: ScheduleTask[];
  dependencies: TaskDependency[];
}

/** Etapa sob minha responsabilidade (Minhas tarefas). */
export interface MyStep {
  id: string; name: string; status: TaskStatus;
  project_id: string; project_name: string; project_code: string | null; client_name: string | null;
  service_name: string;
  planned_start_date: string | null; planned_end_date: string | null; planned_duration_days: number | null; duration_type: DurationType;
  actual_start_date: string | null; actual_end_date: string | null; start_not_before: string | null;
  waiting_reason: string | null; reopen_count: number; status_changed_at: string;
}

/** Tarefa do dia (checklist pessoal). */
export interface WorkItem {
  id: string; title: string; description?: string | null; due_date: string; done_at: string | null;
  project_task_id: string | null; project_id: string | null; created_at: string;
  assigned_at?: string | null;
  project_name?: string | null; project_code?: string | null; step_name?: string | null;
  owner?: TeamPerson;
  /** Preenchido quando a tarefa foi atribuída pela liderança. */
  assigned_by?: { id: string; name: string } | null;
}

/** Pessoa da equipe para quem a liderança pode atribuir tarefas. */
export interface TeamPerson { id: string; name: string; avatar_url: string | null; role: UserRole; employment_type: EmploymentType | null }

/** Observação de uma etapa (registro com autor e data). */
export interface TaskNote { id: string; body: string; created_at: string; author: { name: string } | null }

export interface TaskChange {
  id: string;
  task_id: string | null;
  change_type: "reschedule" | "duration" | "responsible" | "status" | "dependency" | "created" | "recalculated" | "note";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  impacted_task_ids: string[];
  created_at: string;
  author: { name: string } | null;
}

/** Prazo padrão de ajuste por complexidade. */
export type AdjustmentComplexityCode = "simple" | "medium" | "complex";
export interface AdjustmentComplexity {
  code: AdjustmentComplexityCode;
  label: string;
  default_days: number;
  description: string | null;
  sort_order: number;
}

export interface AdjustmentAttachment { path: string; name: string; size: number; type: string }

/** Pedido de ajuste entre setores. */
export interface AdjustmentRequest {
  id: string;
  project_id: string;
  project_name: string;
  project_code: string | null;
  task_id: string;
  task_name: string;
  task_status: TaskStatus;
  target_service: string;
  from_service: string | null;
  complexity: AdjustmentComplexityCode;
  complexity_label: string;
  requested_days: number;
  description: string;
  attachments: AdjustmentAttachment[];
  status: "pending" | "approved" | "rejected" | "cancelled";
  requested_by: { id: string; name: string };
  decided_by: { id: string; name: string } | null;
  decided_at: string | null;
  decision_note: string | null;
  approved_days: number | null;
  assignee: { id: string; name: string } | null;
  result: { mode?: "reopened" | "extended"; impacted_count?: number } | null;
  created_at: string;
  approvers: { id: string; name: string }[];
  can_decide: boolean;
  can_cancel: boolean;
}

/** Motivo padronizado de alteração de prazo. */
export type ReasonKind = "schedule" | "waiting_client" | "waiting_third_party" | "waiting_dependency" | "task_cancel" | "adjustment_reject" | "intake_ignore";

/** Tipo de projeto (lista pré-definida). */
export interface ProjectType { id: string; name: string; sort_order: number; active: boolean }

/** Opção de serviço para a venda (serviço do catálogo ou pacote). */
export interface SaleServiceOption { name: string; group: string; aliases: string[]; kind: "service" | "package"; description?: string | null }

export interface ChangeReason {
  id: string;
  kind: ReasonKind;
  label: string;
  description: string | null;
  client_visible: boolean;
  is_other: boolean;
  sort_order: number;
  active: boolean;
}

/** Alteração de prazo exibida ao cliente. */
export interface ClientScheduleChange {
  id: string;
  project_id: string;
  project_name: string;
  task_name: string;
  service_name: string | null;
  change_type: "reschedule" | "duration" | "reopened";
  reason: string | null;
  reason_detail: string | null;
  before_start: string | null; before_end: string | null;
  after_start: string | null; after_end: string | null;
  impacted_count: number;
  changed_at: string;
}

export interface SchedulePreviewItem {
  id: string; name: string; service: string;
  before_start: string | null; before_end: string | null; after_start: string | null; after_end: string | null;
}
export interface SchedulePreview {
  task: SchedulePreviewItem & { before_duration: number | null; after_duration: number | null };
  impacted: (SchedulePreviewItem & { same_service?: boolean })[];
  impacted_count: number;
  /** Dias úteis de atraso da etapa alterada (0 quando não atrasa). Esse atraso empurra o contrato inteiro. */
  delay_days?: number;
  other_services_count?: number;
  forecast_before: string | null;
  forecast_after: string | null;
}

export interface ServiceFamily { id: string; code: string; name: string; sort_order: number; active: boolean }
export interface CatalogService {
  id: string; family_id: string; code: string; name: string; description: string | null;
  available_for_b2c: boolean; available_for_b2b: boolean; has_schedule_template: boolean; requires_area_rule: boolean;
  sort_order: number; active: boolean; aliases: string[]; leadership_area: LeadershipArea;
}
export type LeadershipArea = "architecture" | "engineering" | "approval";
export interface TemplateTask {
  id: string; template_id: string; code: string; name: string; description: string | null; sort_order: number;
  default_duration_days: number | null; duration_type: DurationType; include_if_service_codes: string[] | null;
  client_visible: boolean; active: boolean;
}
export interface TemplateDependency {
  id: string; template_task_id: string; predecessor_task_id: string | null;
  predecessor_service_code: string | null; predecessor_task_code: string | null;
}
export interface ScheduleTemplate {
  id: string; service_id: string; name: string; version: number; client_type: ClientType | null;
  area_min: number | null; area_max: number | null; status: TemplateStatus; active: boolean; notes: string | null;
  published_at: string | null; created_at: string;
  tasks: TemplateTask[];
}

/** Sub-etapa que pode ser atribuída a um colaborador indireto. */
export interface StepOption {
  project_service_id: string; service_name: string; service_sort: number;
  task_code: string; task_name: string; task_sort: number;
  user_id: string | null; from_schedule: boolean;
}

export interface TaskLibraryItem {
  id: string; name: string; description: string | null; family_id: string | null;
  default_duration_days: number | null; duration_type: DurationType; active: boolean; created_by: string | null; created_at: string;
  sort_order: number | null;
}

/* ---------- Automações ---------- */
export type AutomationTrigger = "project_created" | "project_status_changed" | "task_started" | "task_completed"
  | "task_waiting_client" | "task_overdue" | "service_added" | "card_moved";
export type AutomationActionType = "move_card" | "notify" | "set_task_responsible";
export interface AutomationAction {
  type: AutomationActionType;
  column_id?: string;
  recipients?: string[];
  title?: string;
  message?: string;
  step?: string;
  service?: string;
  assignee?: string;
}
export interface AutomationConditions {
  services?: string[]; steps?: string[]; client_types?: ClientType[]; to_status?: ProjectStatus[]; columns?: string[];
}
export interface AutomationRule {
  id: string; name: string; trigger: AutomationTrigger; conditions: AutomationConditions; actions: AutomationAction[];
  active: boolean; run_count: number; last_run_at: string | null; created_at: string; updated_at: string;
}
export interface AutomationRun {
  id: string; rule_id: string; event: AutomationTrigger; project_id: string | null; task_id: string | null; ok: boolean;
  results: { type: AutomationActionType; ok: boolean; message: string }[];
  context: { task_name?: string; service_name?: string; column_name?: string; to?: string };
  created_at: string;
  project: { id: string; name: string; code: string | null } | null;
  rule: { name: string } | null;
}
export interface AppNotification {
  id: string; kind: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null;
  data: Record<string, unknown>; read_at: string | null; created_at: string;
}

/* ---------- Performance do time ---------- */
export type PerfBand = "low" | "ok" | "great";
export interface PerfActivity { key: string; label: string; is_task: boolean; planned: number; delivered: number; on_time: number }
export interface PerfRow {
  id: string; name: string; avatar_url: string | null; role: UserRole; employment_type: EmploymentType | null; tenant_id: string;
  sector: { id: string; name: string } | null;
  planned: number; delivered: number; on_time: number; late_open: number; late_days_avg: number | null;
  delivery_pct: number | null; on_time_pct: number | null; no_backlog_pct: number | null;
  score: number | null; band: PerfBand | null; activities: PerfActivity[];
}
export interface PerfSettings {
  tenant_id: string; weight_delivery: number; weight_on_time: number; weight_no_backlog: number;
  band_ok: number; band_great: number; min_volume: number; include_assigned_tasks: boolean; highlight_includes_pj: boolean;
}
export interface PerfTrendPoint { month: string; score: number | null; band: PerfBand | null }
export interface PerfOverview {
  month: string; month_end: string; cut: string; tenant_id: string | null; settings: PerfSettings;
  scope: "team" | "self"; can_configure: boolean; can_set_sector: boolean;
  sectors: { id: string; name: string }[]; people: PerfRow[]; trend: Record<string, PerfTrendPoint[]>;
}
export interface PerfItem {
  kind: "step" | "task"; id: string; title: string; project_id: string | null; project: string | null;
  due: string; done?: string | null; status?: string; days?: number; late_days?: number;
}
export interface PerfPersonDetail { month: string; month_end: string; cut: string; person: PerfRow; trend: PerfTrendPoint[] | null; late: PerfItem[]; delivered: PerfItem[] }
export interface PerfHighlight {
  sector: { id: string; name: string }; person: { id: string; name: string; avatar_url: string | null };
  score: number; band: PerfBand; planned: number; delivered: number; on_time_pct: number | null;
}
export interface PerfHighlights { month: string; settings: PerfSettings; items: PerfHighlight[] }

/* ---------- Setores da empresa ---------- */
export interface Sector { id: string; tenant_id: string; name: string; sort_order: number }
export interface SectorRow { id: string; name: string; sort_order: number; people: number }

/* ---------- Funções da equipe ---------- */
export interface JobFunction { id: string; tenant_id: string; profession: string; specialty: string | null; sort_order: number }
export interface JobFunctionRow { id: string; profession: string; specialty: string | null; sort_order: number; people: number }
export interface ProjectTeamMember {
  id: string; name: string; avatar_url: string | null; bio: string | null; is_leader: boolean;
  roles: string[]; areas: string[]; functions: string[];
}

/* ---------- Dúvidas frequentes (FAQ) ---------- */
export interface FaqCategory { id: string; title: string; sort_order: number }
export interface FaqItem {
  id: string; category_id: string; question: string; answer: string;
  keywords: string | null; sort_order: number; updated_at: string;
}
export interface FaqFeedback { id: string; item_id: string | null; helpful: boolean; query: string | null; created_at: string }

/* ---------- Aprovações de projeto e comissões ---------- */
export type ApprovalStatus = "awaiting_review" | "proof_rejected" | "to_release" | "released" | "paid" | "cancelled";
export interface ApprovalProof { path: string; name: string; size: number; type: string }
export interface ApprovalRecord {
  id: string; project_id: string; tenant_id: string; project_name: string; project_code: string | null; client_name: string | null; tenant_name: string | null;
  type_id: string; type_name: string; type_code: string;
  protocol_number: string | null; approved_on: string; proof: ApprovalProof; notes: string | null;
  status: ApprovalStatus; review_note: string | null; cancel_note: string | null;
  registered_at: string; reviewed_at: string | null; released_at: string | null; paid_at: string | null;
  registered_by: { id: string; name: string } | null; reviewed_by: { id: string; name: string } | null;
  recipient: { id: string; name: string; avatar_url: string | null; employment_type: EmploymentType | null } | null;
  amount: number | null; can_resubmit: boolean; can_review: boolean; can_admin: boolean;
}
export interface ApprovalProtocol {
  type_id: string; type_code: string; type_name: string; project_service_id: string; service_name: string;
  task_id: string | null; task_status: TaskStatus | null; approval_id: string | null; approval_status: ApprovalStatus | null;
}
export interface ApprovalBoard {
  can_register: boolean; can_include: boolean; protocols: ApprovalProtocol[]; approvals: ApprovalRecord[];
  tramites: { service_id: string; name: string; included: boolean }[];
}
export interface ApprovalRate { type_id: string; code: string; name: string; amount: number | null; updated_at: string | null }

/* ---------- Customer Success ---------- */
export type CsKind = "clarification" | "client_question" | "alert";
export type CsUrgency = "normal" | "high" | "urgent";
export type CsStatus = "open" | "answered" | "resolved" | "cancelled";
export interface CsRequest {
  id: string; project_id: string; tenant_id: string; project_name: string; project_code: string | null; client_name: string | null;
  kind: CsKind; urgency: CsUrgency; title: string; body: string;
  task: { id: string; name: string; status: TaskStatus; planned_end_date: string | null } | null;
  status: CsStatus; due_at: string; created_at: string; first_response_at: string | null; last_reply_at: string | null; resolved_at: string | null;
  created_by: { id: string; name: string }; recipients: { id: string; name: string; avatar_url: string | null }[];
  messages: number; last_message: { author: string; body: string; at: string; from_cs: boolean } | null;
  overdue: boolean; answered_late: boolean; is_recipient: boolean; can_close: boolean; can_reopen: boolean;
}
export interface CsMessage { id: string; body: string; created_at: string; author: { id: string; name: string; avatar_url: string | null; role: UserRole } }
export interface CsRequestDetail extends CsRequest { thread: CsMessage[] }
export interface CsRiskProject {
  id: string; name: string; code: string | null; client_name: string | null; overdue_steps: number; max_overdue_days: number | null;
  waiting_client: number; next_due: string | null; open_requests: number;
}
export interface CsUpcoming {
  task_id: string; project_id: string; project_name: string; project_code: string | null; client_name: string | null;
  task: string; service: string; planned_end_date: string; status: TaskStatus; responsible: string | null;
}
export interface CsDashboard {
  scope: "network" | "unit";
  counts: { open: number; awaiting_team: number; answered: number; urgent_open: number; overdue: number; created_month: number; resolved_month: number };
  response: { avg_hours: number | null; on_time_pct: number | null; answered: number };
  by_kind: { kind: CsKind; open: number; month: number }[];
  trend: { week: string; created: number; resolved: number }[];
  attention: CsRequest[];
  projects: { active: number; with_overdue: number; waiting_client: number };
  at_risk: CsRiskProject[];
  upcoming: CsUpcoming[];
}
export interface CsSettings { tenant_id: string; normal_days: number; high_days: number; urgent_hours: number }

/* ---------- NPS ---------- */
export interface NpsPending { project_service_id: string; project_id: string; project_name: string; service_name: string; completed_on: string; question: string }
export type NpsCategory = "promoter" | "passive" | "detractor";
export interface NpsOverview {
  from: string; to: string; responses: number; promoters: number; passives: number; detractors: number;
  nps: number | null; prev_nps: number | null; avg_score: number | null;
  completed_services: number; answered_services: number; pending_services: number;
  distribution: number[];
  by_service: { service: string; responses: number; nps: number; avg_score: number }[];
  by_month: { month: string; responses: number; nps: number | null }[];
}
export interface NpsResponse {
  id: string; score: number; comment: string | null; answered_at: string; completed_on: string | null;
  project_id: string; project_name: string; project_code: string | null; client_name: string | null;
  service_name: string; respondent: string; tenant_name: string | null; category: NpsCategory;
}
