// Tipos de domínio espelhando o schema do banco (supabase/migrations).

export type UserRole = "client" | "collaborator" | "leader" | "unit_admin" | "global_admin";
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
    service: { id: string; name: string; code: string; family: { name: string; default_project_role: string | null } | null } | null;
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
