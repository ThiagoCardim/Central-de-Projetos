// Supabase simulado para PREVIEW VISUAL local (scripts/preview). Nunca é usado no build de produção.
// Escolha o perfil com ?as=global_admin | unit_admin | leader | clt | pj | client | empty
/* eslint-disable @typescript-eslint/no-explicit-any */

const today = new Date();
const d = (offset: number) => {
  const x = new Date(today); x.setDate(x.getDate() + offset);
  return x.toISOString().slice(0, 10);
};

const HQ = "00000000-0000-4000-8000-000000000001";
const POCOS = "00000000-0000-4000-8000-0000000000a1";
const CAMPINAS = "00000000-0000-4000-8000-0000000000b1";

const tenants = [
  { id: HQ, name: "YouCon Franqueadora", type: "franqueadora", status: "ativo", parent_tenant_id: null, slug: "youcon", city: "Poços de Caldas", state: "MG", created_at: "2026-01-10T12:00:00Z" },
  { id: POCOS, name: "YouCon Sul de Minas", type: "franquia", status: "ativo", parent_tenant_id: HQ, slug: "sul-de-minas", city: "Pouso Alegre", state: "MG", created_at: "2026-06-02T12:00:00Z" },
  { id: CAMPINAS, name: "YouCon Campinas", type: "franquia", status: "inativo", parent_tenant_id: HQ, slug: "campinas", city: "Campinas", state: "SP", created_at: "2026-08-15T12:00:00Z" },
];

let profiles: any[] = [
  ["p-ga", HQ, "Thiago Cardim", "thiago@youcon.com.br", "global_admin", null, null, "ativo", true],
  ["p-ua", HQ, "Mariana Lopes", "mariana@youcon.com.br", "unit_admin", "clt", null, "ativo", true],
  ["p-ld", HQ, "Rafael Andrade", "rafael@youcon.com.br", "leader", "clt", null, "ativo", true],
  ["p-c1", HQ, "Beatriz Nogueira", "beatriz@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-c2", HQ, "Lucas Ferreira", "lucas@youcon.com.br", "collaborator", "clt", null, "ativo", true],
  ["p-pj", HQ, "Camila Rocha", "camila.eng@gmail.com", "collaborator", "pj", null, "ativo", true],
  ["p-pj2", HQ, "Eduardo Prado", "eduardo.estrutural@gmail.com", "collaborator", "pj", null, "ativo", false],
  ["p-cl", HQ, "Fernanda Souza", "fernanda.souza@gmail.com", "client", null, "b2c", "ativo", true],
  ["p-cl2", HQ, "Construtora Horizonte", "obras@horizonte.com.br", "client", null, "b2b", "ativo", true],
  ["p-in", HQ, "Paulo Mendes", "paulo@youcon.com.br", "collaborator", "clt", null, "inativo", true],
  ["p-fa", POCOS, "Juliana Prates", "juliana@youconsuldeminas.com.br", "unit_admin", null, null, "ativo", true],
  ["p-fl", POCOS, "André Vilela", "andre@youconsuldeminas.com.br", "leader", "pj", null, "ativo", true],
].map(([id, tenant_id, name, email, role, employment_type, client_type, status, linked], i) => ({
  id, auth_user_id: linked ? `auth-${id}` : null, tenant_id, name, email, role, employment_type, client_type, status,
  phone: null, avatar_url: null, invited_at: `2026-0${(i % 8) + 1}-1${i % 9}T12:00:00Z`, last_seen_at: null, created_at: "2026-01-10T12:00:00Z",
}));

const clients = [
  { id: "c-1", tenant_id: HQ, name: "Fernanda Souza", client_type: "b2c", email: "fernanda.souza@gmail.com", status: "ativo" },
  { id: "c-2", tenant_id: HQ, name: "Construtora Horizonte", client_type: "b2b", email: "obras@horizonte.com.br", status: "ativo" },
];

const ROLE_PROFILE: Record<string, string> = {
  global_admin: "p-ga", unit_admin: "p-ua", leader: "p-ld", clt: "p-c1", pj: "p-pj", client: "p-cl", empty: "p-ga",
};

function currentKey(): string | null {
  const as = new URLSearchParams(location.search).get("as");
  if (as) { try { sessionStorage.setItem("mock-as", as); } catch { /* */ } return as; }
  try { return sessionStorage.getItem("mock-as"); } catch { return null; }
}
const me = () => profiles.find((p) => p.id === ROLE_PROFILE[currentKey() ?? ""]) ?? null;

function permissions() {
  const p = me(); if (!p) return null;
  const r = p.role;
  const global = r === "global_admin";
  return {
    profile_id: p.id, tenant_id: p.tenant_id, role: r, employment_type: p.employment_type, client_type: p.client_type,
    can_manage_users: global || r === "unit_admin", can_manage_tenant: global || r === "unit_admin",
    can_manage_tenants: global, can_manage_templates: global, can_distribute: global,
    can_view_intake: global || r === "unit_admin", can_view_performance: p.employment_type === "clt",
    is_manager: ["leader", "unit_admin", "global_admin"].includes(r), is_staff: r !== "client",
  };
}

const alert = (o: any) => ({
  responsible_user_id: null, planned_start_date: null, project_code: null, due_in_days: null, overdue_days: null, waiting_days: null,
  is_overdue: false, is_blocked: false, is_waiting_client: false, is_unassigned: false, ...o,
});

const ALERTS = [
  alert({ task_id: "t1", project_id: "pr1", task_name: "Estudo Preliminar", status: "in_progress", responsible_user_id: "p-c1", planned_end_date: d(-4), project_name: "Residência Souza", service_name: "Projeto Arquitetônico", due_in_days: -4, overdue_days: 4, is_overdue: true }),
  alert({ task_id: "t2", project_id: "pr2", task_name: "Projeto Legal", status: "in_progress", responsible_user_id: "p-c2", planned_end_date: d(-1), project_name: "Edifício Horizonte", service_name: "Aprovação / Projeto Legal", due_in_days: -1, overdue_days: 1, is_overdue: true }),
  alert({ task_id: "t3", project_id: "pr2", task_name: "Aprovação ou Alvará", status: "waiting_third_party", responsible_user_id: "p-c2", planned_end_date: d(12), project_name: "Edifício Horizonte", service_name: "Aprovação / Projeto Legal", due_in_days: 12, waiting_days: 6, is_blocked: true }),
  alert({ task_id: "t4", project_id: "pr3", task_name: "Envio do Briefing", status: "waiting_client", responsible_user_id: "p-c1", planned_end_date: d(2), project_name: "Clínica Vida", service_name: "Design de Interiores", due_in_days: 2, waiting_days: 5, is_waiting_client: true }),
  alert({ task_id: "t5", project_id: "pr1", task_name: "Briefing Arq + Apr + Eng", status: "ready", responsible_user_id: "p-pj", planned_end_date: d(0), project_name: "Residência Souza", service_name: "Projeto Elétrico", due_in_days: 0 }),
  alert({ task_id: "t6", project_id: "pr2", task_name: "Planejamento", status: "not_started", responsible_user_id: null, planned_end_date: d(9), project_name: "Edifício Horizonte", service_name: "Projeto Estrutural", due_in_days: 9, is_unassigned: true }),
  alert({ task_id: "t7", project_id: "pr3", task_name: "Renderização", status: "not_started", responsible_user_id: "p-c1", planned_end_date: d(1), project_name: "Clínica Vida", service_name: "Design de Interiores", due_in_days: 1 }),
];

function dashboard(): any {
  const p = me()!;
  const key = currentKey();
  const tenant = tenants.find((t) => t.id === p.tenant_id)!;
  const base = { me: { id: p.id, name: p.name, role: p.role, employment_type: p.employment_type, client_type: p.client_type, tenant: { id: tenant.id, name: tenant.name, type: tenant.type } }, generated_at: new Date().toISOString() };

  if (p.role === "client") {
    return { ...base, client: { projects: [{
      id: "pr1", code: "YC-2026-0014", name: "Residência Souza", status: "in_progress", city: "Poços de Caldas", state: "MG",
      contracted_at: d(-48), forecast_end: d(96), progress: 31, pending_from_client: 1,
      services: [
        { name: "Projeto Arquitetônico", track_status: "in_progress", progress: 40, current_step: { name: "Estudo Preliminar", status: "in_progress", planned_end_date: d(6) }, next_step: { name: "Alterações", planned_start_date: d(7) }, planned_end_date: d(68),
          steps: [
            { name: "Planejamento", status: "completed", planned_end_date: d(-30), actual_end_date: d(-31) },
            { name: "Envio do Briefing", status: "completed", planned_end_date: d(-20), actual_end_date: d(-19) },
            { name: "Estudo Preliminar", status: "in_progress", planned_end_date: d(6), actual_end_date: null },
            { name: "Alterações", status: "not_started", planned_end_date: d(48), actual_end_date: null },
            { name: "Imagens 3D e Vídeo", status: "not_started", planned_end_date: d(68), actual_end_date: null },
          ] },
        { name: "Design de Interiores", track_status: "in_progress", progress: 14, current_step: { name: "Envio do Briefing", status: "waiting_client", planned_end_date: d(2) }, next_step: { name: "Projeto de Interiores", planned_start_date: d(3) }, planned_end_date: d(96),
          steps: [
            { name: "Planejamento", status: "completed", planned_end_date: d(-6), actual_end_date: d(-6) },
            { name: "Envio do Briefing", status: "waiting_client", planned_end_date: d(2), actual_end_date: null },
            { name: "Projeto de Interiores", status: "not_started", planned_end_date: d(16), actual_end_date: null },
            { name: "Alteração", status: "not_started", planned_end_date: d(37), actual_end_date: null },
            { name: "Renderização", status: "not_started", planned_end_date: d(51), actual_end_date: null },
            { name: "Detalhamento", status: "not_started", planned_end_date: d(72), actual_end_date: null },
            { name: "Assessoria", status: "not_started", planned_end_date: d(79), actual_end_date: null },
          ] },
      ],
    }] } };
  }

  const mine = ALERTS.filter((a) => a.responsible_user_id === p.id);
  const out: any = { ...base, my_work: {
    counts: {
      open: mine.length, overdue: mine.filter((a) => a.is_overdue).length,
      due_today: mine.filter((a) => a.due_in_days === 0).length,
      due_next_7: mine.filter((a) => (a.due_in_days ?? 99) >= 1 && (a.due_in_days ?? 99) <= 7).length,
      waiting_client: mine.filter((a) => a.is_waiting_client).length, blocked: mine.filter((a) => a.is_blocked).length,
    },
    tasks: mine,
    projects: p.role === "collaborator" ? [
      { id: "pr1", code: "YC-2026-0014", name: "Residência Souza", status: "in_progress", project_role: p.employment_type === "pj" ? "Engenharia" : "Arquitetura" },
      ...(p.employment_type === "clt" ? [{ id: "pr3", code: "YC-2026-0019", name: "Clínica Vida", status: "in_progress", project_role: "Interiores" }] : []),
    ] : [],
  } };

  if (["leader", "unit_admin", "global_admin"].includes(p.role)) {
    const empty = key === "empty";
    out.operations = {
      counts: empty
        ? { projects_active: 0, awaiting_team: 0, awaiting_allocation: 0, tasks_overdue: 0, tasks_blocked: 0, tasks_waiting_client: 0, tasks_unassigned: 0, due_next_7: 0, projects_at_risk: 0, services_pending_review: 0 }
        : { projects_active: 6, awaiting_team: 2, awaiting_allocation: 0, tasks_overdue: 2, tasks_blocked: 1, tasks_waiting_client: 1, tasks_unassigned: 1, due_next_7: 4, projects_at_risk: 2, services_pending_review: 1 },
      awaiting_team: empty ? [] : [
        { id: "pr8", code: "YC-2026-0023", name: "Casa de campo", project_type: "Residencial", client_type: "b2c", client_name: "Ricardo e Helena Tavares", city: "Caldas", state: "MG", contracted_at: d(-2), services: ["Projeto Arquitetônico", "Projeto Estrutural", "Projeto Elétrico", "Projeto Hidrossanitário"] },
        { id: "pr9", code: "YC-2026-0024", name: "Galpão logístico", project_type: "Industrial", client_type: "b2b", client_name: "Construtora Horizonte", city: "Pouso Alegre", state: "MG", contracted_at: d(-1), services: ["Estudo de Viabilidade", "SPDA", "Combate a Incêndio"] },
      ],
      alerts: empty ? [] : ALERTS,
      team_load: empty ? [] : [
        { id: "p-c1", name: "Beatriz Nogueira", open: 7, overdue: 1 },
        { id: "p-c2", name: "Lucas Ferreira", open: 5, overdue: 1 },
        { id: "p-pj", name: "Camila Rocha", open: 3, overdue: 0 },
        { id: "p-ld", name: "Rafael Andrade", open: 1, overdue: 0 },
      ],
    };
    if (empty) out.my_work = { counts: { open: 0, overdue: 0, due_today: 0, due_next_7: 0, waiting_client: 0, blocked: 0 }, tasks: [], projects: [] };
  }
  if (["unit_admin", "global_admin"].includes(p.role)) {
    out.admin = {
      users: key === "empty" ? { active: 1, inactive: 0, clt: 0, pj: 0, clients: 0, pending_invite: 0 } : { active: 7, inactive: 1, clt: 4, pj: 2, clients: 2, pending_invite: 1 },
      intake: { received: key === "empty" ? 0 : 1, errors: 0, last_24h: key === "empty" ? 0 : 2 },
      tenants: p.role === "global_admin" ? overview() : null,
    };
  }
  return out;
}

function overview() {
  const p = me();
  return tenants
    .filter((t) => p?.role === "global_admin" || t.id === p?.tenant_id)
    .map((t) => {
      const ps = profiles.filter((x) => x.tenant_id === t.id);
      return {
        tenant_id: t.id, name: t.name, type: t.type, status: t.status, city: t.city, state: t.state,
        users_active: ps.filter((x) => x.status === "ativo" && x.role !== "client").length,
        users_inactive: ps.filter((x) => x.status === "inativo").length,
        collaborators_clt: ps.filter((x) => x.status === "ativo" && x.employment_type === "clt").length,
        collaborators_pj: ps.filter((x) => x.status === "ativo" && x.employment_type === "pj").length,
        clients: clients.filter((c) => c.tenant_id === t.id).length,
        projects_active: t.id === HQ ? 6 : t.id === POCOS ? 2 : 0,
        projects_awaiting: t.id === HQ ? 2 : 0,
        created_at: t.created_at,
      };
    });
}

const delay = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

function rpc(name: string, _args?: any) {
  switch (name) {
    case "my_permissions": return delay({ data: permissions(), error: null });
    case "get_home_dashboard": return delay({ data: dashboard(), error: null }, 350);
    case "tenant_overview": return delay({ data: overview(), error: null });
    case "admin_create_tenant": return delay({ data: "new-id", error: null });
    case "assign_project_team": return delay({ data: { started: true, added: 2, removed: 0 }, error: null }, 400);
    case "allocate_project": case "ignore_intake": return delay({ data: null, error: null }, 400);
    case "reprocess_intake": case "create_manual_intake":
      return delay({ data: { status: "error", errors: ["Serviço não reconhecido: Ar condicionado"] }, error: null }, 400);
    default: return delay({ data: null, error: { message: `rpc ${name} não simulada` } });
  }
}

// ---------- Etapa 2 ----------
const svc = (id: string, name: string, family: string, role: string, status = "active", contracted = d(-2)) =>
  ({ id: `ps-${id}`, status, active: true, contracted_at: contracted, contract_source: "pipefy",
     service: { id, name, code: id, family: { name: family, default_project_role: role } } });

const PROJECTS: any[] = [
  { id: "pr8", code: "YC-2026-0023", name: "Casa de campo", status: "awaiting_team_assignment", client_type: "b2c", project_type: "Residencial",
    city: "Caldas", state: "MG", address: "Estrada da Serra, km 4", area_m2: 286.5, contracted_at: d(-2), created_at: d(-2) + "T14:10:00Z", started_at: null,
    external_source: "pipefy", external_id: "1029384756", origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: HQ,
    client: { id: "c-3", tenant_id: HQ, name: "Ricardo e Helena Tavares", client_type: "b2c", email: "ricardo.tavares@gmail.com", phone: "(35) 99812-4410", document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: { name: "YouCon Franqueadora" },
    services: [svc("arq", "Projeto Arquitetônico", "Arquitetura", "architecture"), svc("est", "Projeto Estrutural", "Engenharia", "engineering"),
               svc("ele", "Projeto Elétrico", "Engenharia", "engineering"), svc("hid", "Projeto Hidrossanitário", "Engenharia", "engineering")],
    team: [], allocations: [{ id: "al1", allocation_method: "automatic_headquarters", allocation_status: "confirmed", allocated_at: d(-2) + "T14:10:00Z", notes: null, created_at: d(-2) + "T14:10:00Z", delivery: { name: "YouCon Franqueadora" } }] },
  { id: "pr9", code: "YC-2026-0024", name: "Galpão logístico", status: "awaiting_allocation", client_type: "b2b", project_type: "Industrial",
    city: "Pouso Alegre", state: "MG", address: null, area_m2: 4200, contracted_at: d(-1), created_at: d(-1) + "T10:00:00Z", started_at: null,
    external_source: "pipefy", external_id: "1029384999", origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: null,
    client: { id: "c-2", tenant_id: HQ, name: "Construtora Horizonte", client_type: "b2b", email: "obras@horizonte.com.br", phone: null, document: "12345678000190", company_name: "Horizonte Engenharia Ltda.", status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: null,
    services: [svc("via", "Estudo de Viabilidade", "Arquitetura", "architecture"), svc("spda", "SPDA", "Engenharia", "engineering"), svc("inc", "Combate a Incêndio", "Engenharia", "engineering")],
    team: [], allocations: [{ id: "al2", allocation_method: "manual", allocation_status: "pending", allocated_at: null, notes: null, created_at: d(-1) + "T10:00:00Z", delivery: null }] },
  { id: "pr1", code: "YC-2026-0014", name: "Residência Souza", status: "in_progress", client_type: "b2c", project_type: "Residencial",
    city: "Poços de Caldas", state: "MG", address: null, area_m2: 210, contracted_at: d(-48), created_at: d(-48) + "T10:00:00Z", started_at: d(-46),
    external_source: "pipefy", external_id: "998877", origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: HQ,
    client: { id: "c-1", tenant_id: HQ, name: "Fernanda Souza", client_type: "b2c", email: "fernanda.souza@gmail.com", phone: null, document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: { name: "YouCon Franqueadora" },
    services: [svc("arq", "Projeto Arquitetônico", "Arquitetura", "architecture", "active", d(-48)), svc("int", "Design de Interiores", "Interiores", "interiors", "active", d(-48)),
               svc("ele", "Projeto Elétrico", "Engenharia", "engineering", "pending_review", d(-3))],
    team: [
      { id: "tm1", project_role: "project_lead", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-ld", name: "Rafael Andrade", avatar_url: null, employment_type: "clt" } },
      { id: "tm2", project_role: "architecture", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-c1", name: "Beatriz Nogueira", avatar_url: null, employment_type: "clt" } },
      { id: "tm3", project_role: "engineering", employment_type: "pj", active: true, assigned_at: d(-3), user: { id: "p-pj", name: "Camila Rocha", avatar_url: null, employment_type: "pj" } },
    ],
    allocations: [{ id: "al3", allocation_method: "automatic_headquarters", allocation_status: "confirmed", allocated_at: d(-48) + "T10:00:00Z", notes: null, created_at: d(-48) + "T10:00:00Z", delivery: { name: "YouCon Franqueadora" } }] },
  { id: "pr3", code: "YC-2026-0019", name: "Clínica Vida", status: "in_progress", client_type: "b2b", project_type: "Comercial",
    city: "Poços de Caldas", state: "MG", address: null, area_m2: 140, contracted_at: d(-20), created_at: d(-20) + "T10:00:00Z", started_at: d(-19),
    external_source: "manual", external_id: null, origin_tenant_id: HQ, commercial_tenant_id: HQ, delivery_tenant_id: HQ,
    client: { id: "c-4", tenant_id: HQ, name: "Clínica Vida", client_type: "b2b", email: "contato@clinicavida.com.br", phone: null, document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Franqueadora" }, commercial: { name: "YouCon Franqueadora" }, delivery: { name: "YouCon Franqueadora" },
    services: [svc("int", "Design de Interiores", "Interiores", "interiors", "active", d(-20))],
    team: [{ id: "tm4", project_role: "project_lead", employment_type: "clt", active: true, assigned_at: d(-19), user: { id: "p-c1", name: "Beatriz Nogueira", avatar_url: null, employment_type: "clt" } }],
    allocations: [] },
  { id: "pr4", code: "YC-2026-0007", name: "Apartamento 1201", status: "completed", client_type: "b2c", project_type: "Residencial",
    city: "Pouso Alegre", state: "MG", address: null, area_m2: 98, contracted_at: d(-160), created_at: d(-160) + "T10:00:00Z", started_at: d(-158),
    external_source: "pipefy", external_id: "555", origin_tenant_id: POCOS, commercial_tenant_id: POCOS, delivery_tenant_id: POCOS,
    client: { id: "c-5", tenant_id: POCOS, name: "Marcos Ribeiro", client_type: "b2c", email: null, phone: null, document: null, company_name: null, status: "ativo" },
    origin: { name: "YouCon Sul de Minas" }, commercial: { name: "YouCon Sul de Minas" }, delivery: { name: "YouCon Sul de Minas" },
    services: [svc("int", "Design de Interiores", "Interiores", "interiors", "completed", d(-160))], team: [], allocations: [] },
];

const INTAKES: any[] = [
  { id: "in1", source: "pipefy", external_id: "1029385111", intake_kind: "new_project", target_external_id: null, client_name: "Gustavo Lima Arquitetura", client_email: null, client_phone: "(35) 98888-1122",
    client_document: null, client_type: null, project_name: "Sede administrativa", project_type: "Comercial", services: ["Projeto Arquitetonico", "Ar condicionado"], resolved_services: null,
    contracted_at: d(0), contract_value: 48500, area_m2: 620, city: "Varginha", state: "MG", address: null, salesperson: "Thiago", notes: null,
    status: "error", validation_error: "Tipo de cliente não informado (B2C ou B2B).",
    validation_details: { errors: ["Tipo de cliente não informado (B2C ou B2B).", "Serviço não reconhecido: Ar condicionado"] },
    received_at: new Date(Date.now() - 3600e3).toISOString(), processed_at: null, created_project_id: null,
    raw_payload: { card_id: "1029385111", cliente: "Gustavo Lima Arquitetura", servicos: "Projeto Arquitetonico, Ar condicionado", valor: "48.500,00" } },
  { id: "in2", source: "pipefy", external_id: "1029384999", intake_kind: "new_project", target_external_id: null, client_name: "Construtora Horizonte", client_email: "obras@horizonte.com.br", client_phone: null,
    client_document: "12345678000190", client_type: "b2b", project_name: "Galpão logístico", project_type: "Industrial", services: ["Estudo de Viabilidade", "SPDA", "Combate a Incêndio"], resolved_services: ["via", "spda", "inc"],
    contracted_at: d(-1), contract_value: 132000, area_m2: 4200, city: "Pouso Alegre", state: "MG", address: null, salesperson: "Mariana", notes: null,
    status: "processed", validation_error: null, validation_details: null, received_at: d(-1) + "T10:00:00Z", processed_at: d(-1) + "T10:00:01Z", created_project_id: "pr9",
    raw_payload: { card_id: "1029384999" } },
  { id: "in3", source: "pipefy", external_id: "1029384756", intake_kind: "new_project", target_external_id: null, client_name: "Ricardo e Helena Tavares", client_email: "ricardo.tavares@gmail.com", client_phone: null,
    client_document: null, client_type: "b2c", project_name: "Casa de campo", project_type: "Residencial", services: ["Projeto Arquitetônico", "Projeto Estrutural", "Projeto Elétrico", "Projeto Hidrossanitário"], resolved_services: [],
    contracted_at: d(-2), contract_value: 61800, area_m2: 286.5, city: "Caldas", state: "MG", address: null, salesperson: "Thiago", notes: null,
    status: "processed", validation_error: null, validation_details: null, received_at: d(-2) + "T14:10:00Z", processed_at: d(-2) + "T14:10:01Z", created_project_id: "pr8",
    raw_payload: { card_id: "1029384756" } },
  { id: "in4", source: "pipefy", external_id: "1029380000", intake_kind: "new_project", target_external_id: null, client_name: "Teste Pipefy", client_email: null, client_phone: null,
    client_document: null, client_type: null, project_name: null, project_type: null, services: [], resolved_services: null,
    contracted_at: null, contract_value: null, area_m2: null, city: null, state: null, address: null, salesperson: null, notes: null,
    status: "ignored", validation_error: "Card de teste", validation_details: null, received_at: d(-5) + "T09:00:00Z", processed_at: null, created_project_id: null, raw_payload: {} },
];

const ROLES = [
  { code: "project_lead", name: "Líder do Projeto", sort_order: 1, required: true, active: true },
  { code: "architecture", name: "Arquitetura", sort_order: 2, required: false, active: true },
  { code: "engineering", name: "Engenharia", sort_order: 3, required: false, active: true },
  { code: "interiors", name: "Interiores", sort_order: 4, required: false, active: true },
  { code: "approval", name: "Aprovação", sort_order: 5, required: false, active: true },
  { code: "consulting", name: "Consultoria", sort_order: 6, required: false, active: true },
];

function visibleRows(table: string): any[] {
  const p = me();
  if (!p) return [];
  const global = p.role === "global_admin";
  if (table === "projects") {
    if (currentKey() === "empty") return [];
    const list = PROJECTS.filter((x) => global || x.delivery_tenant_id === p.tenant_id || x.commercial_tenant_id === p.tenant_id);
    return p.role === "collaborator" ? list.filter((x) => x.team.some((t: any) => t.user?.id === p.id)) : list;
  }
  if (table === "project_intakes") return currentKey() === "empty" ? [] : INTAKES;
  if (table === "project_roles") return ROLES;
  if (table === "services") return ["Projeto Arquitetônico", "Projeto Estrutural", "Projeto Elétrico", "Projeto Hidrossanitário", "Design de Interiores", "SPDA"].map((name) => ({ name }));
  if (table === "service_packages") return [{ name: "Projetos Complementares" }];
  if (table === "project_team") {
    return PROJECTS.flatMap((x) => x.team.filter((t: any) => t.active).map((t: any) => ({ active: true, user_id: t.user.id, project_role: t.project_role, project: { id: x.id, name: x.name, status: x.status, delivery_tenant_id: x.delivery_tenant_id } })));
  }
  if (table === "profiles") return profiles.filter((x) => global || x.tenant_id === p.tenant_id || x.id === p.id);
  if (table === "tenants") return tenants.filter((t) => global || t.id === p.tenant_id);
  if (table === "clients") {
    return clients.filter((c) => global || c.tenant_id === p.tenant_id).map((c) => ({
      phone: null, document: null, company_name: null, created_at: "2026-05-01T12:00:00Z", ...c,
      projects: [{ count: PROJECTS.filter((x) => x.client?.id === c.id).length }],
    }));
  }
  return [];
}

function from(table: string) {
  const filters: [string, any][] = [];
  let mode: "select" | "insert" | "update" = "select";
  let single = false;
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (col: string, val: any) => { if (!col.includes(".")) filters.push([col, val]); return q; },
    in: () => q,
    limit: () => q,
    single: () => { single = true; return q; },
    maybeSingle: () => { single = true; return q; },
    insert: () => { mode = "insert"; return q; },
    update: () => { mode = "update"; return q; },
    then: (resolve: any, reject: any) => {
      let rows = visibleRows(table).filter((r) => filters.every(([c, v]) => r[c] === v));
      const result = mode !== "select" ? { data: null, error: null } : { data: single ? rows[0] ?? null : rows, error: null };
      return delay(result).then(resolve, reject);
    },
  };
  return q;
}

type Listener = (event: string, session: any) => void;
const listeners: Listener[] = [];
const session = () => (me() ? { access_token: "mock", user: { id: me()!.auth_user_id, email: me()!.email } } : null);

export function createClient() {
  return {
    auth: {
      getSession: () => delay({ data: { session: session() }, error: null }, 50),
      onAuthStateChange: (cb: Listener) => { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: ({ email }: any) => {
        const p = profiles.find((x) => x.email === email);
        if (!p) return delay({ data: null, error: { message: "Invalid login credentials" } }, 400);
        if (p.status !== "ativo") return delay({ data: null, error: { message: "Seu acesso está inativo. Fale com o administrador da sua unidade." } }, 400);
        const key = Object.entries(ROLE_PROFILE).find(([, v]) => v === p.id)?.[0];
        if (key) sessionStorage.setItem("mock-as", key);
        setTimeout(() => listeners.forEach((l) => l("SIGNED_IN", session())), 0);
        return delay({ data: {}, error: null }, 400);
      },
      signOut: async () => { sessionStorage.removeItem("mock-as"); history.replaceState(null, "", location.pathname); listeners.forEach((l) => l("SIGNED_OUT", null)); return { error: null }; },
      resetPasswordForEmail: () => delay({ data: {}, error: null }, 400),
      updateUser: () => delay({ data: {}, error: null }, 400),
    },
    rpc,
    from,
    functions: {
      invoke: (_name: string, { body }: any) => {
        if (body.action === "invite" && profiles.some((p) => p.email === body.email)) {
          return delay({ data: null, error: { context: new Response(JSON.stringify({ message: "Já existe um usuário com este e-mail" })) } }, 500);
        }
        if (body.action === "invite") {
          profiles = [...profiles, { id: `p-${Date.now()}`, auth_user_id: null, tenant_id: body.tenant_id, name: body.name, email: body.email, role: body.role, employment_type: body.employment_type ?? null, client_type: body.client_type ?? null, status: "ativo", phone: null, avatar_url: null, invited_at: new Date().toISOString(), last_seen_at: null, created_at: new Date().toISOString() }];
        }
        if (body.action === "set_status") profiles = profiles.map((p) => p.id === body.profile_id ? { ...p, status: body.status } : p);
        if (body.action === "update") profiles = profiles.map((p) => p.id === body.profile_id ? { ...p, name: body.name, role: body.role, employment_type: body.employment_type, client_type: body.client_type } : p);
        return delay({ data: { ok: true }, error: null }, 500);
      },
    },
  };
}
