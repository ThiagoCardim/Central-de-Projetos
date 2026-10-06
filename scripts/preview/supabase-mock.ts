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
    case "preview_task_change": return delay({ data: {
      task: { id: _args?.p_task, name: "Estudo Preliminar", service: "Projeto Arquitetônico", before_start: d(-30), before_end: d(-2), after_start: d(-30), after_end: d(3),
        before_duration: 20, after_duration: 25 },
      impacted: [
        { id: "a", name: "Alterações", service: "Projeto Arquitetônico", before_start: d(-1), before_end: d(41), after_start: d(4), after_end: d(46) },
        { id: "b", name: "Imagens 3D e Vídeo", service: "Projeto Arquitetônico", before_start: d(42), before_end: d(55), after_start: d(47), after_end: d(60) },
        { id: "c", name: "Tempo de Produção da Arquitetura", service: "Projeto Estrutural", before_start: d(-40), before_end: d(-2), after_start: d(-40), after_end: d(3) },
        { id: "e", name: "Revisão APR x ARQ x ENG", service: "Projeto Estrutural", before_start: d(-1), before_end: d(0), after_start: d(4), after_end: d(5) },
      ], impacted_count: 4, forecast_before: d(55), forecast_after: d(60) }, error: null }, 300);
    case "reschedule_task": case "set_task_status": case "add_task_dependency": case "remove_task_dependency":
      return delay({ data: { impacted_count: 3, status: _args?.p_status }, error: null }, 300);
    case "set_task_responsible": case "set_profile_avatar": case "save_template_draft": case "publish_template": case "discard_template_draft":
      return delay({ data: null, error: null }, 300);
    case "reorder_task_library": return delay({ data: null, error: null }, 200);
    case "project_step_options": {
      const pr = PROJECTS.find((x) => x.id === _args?.p_project);
      const rows = (pr?.services ?? []).flatMap((x: any, si: number) => {
        const tpl = TEMPLATES.find((t) => t.service_id === x.service.id && t.active);
        return (tpl?.tasks ?? []).map((t: any) => ({ project_service_id: x.id, service_name: x.service.name, service_sort: si, task_code: t.code, task_name: t.name,
          task_sort: t.sort_order, user_id: pr.id === "pr1" && x.service.id === "arq" && t.code === "imagens_3d_video" ? "p-pj2" : null, from_schedule: pr.status === "in_progress" }));
      });
      return delay({ data: rows, error: null });
    }
    case "set_step_assignments": return delay({ data: { added: 1, removed: 0, tasks_updated: 1 }, error: null }, 300);
    case "template_usage": return delay({ data: TEMPLATES.filter((t) => t.service_id === _args?.p_service).map((t) => ({ template_id: t.id, projects_in_progress: t.active ? 3 : 0 })), error: null });
    case "delete_template_variant": return delay({ data: { archived: 1, projects_in_progress: 3 }, error: null }, 300);
    case "add_project_task": return delay({ data: { task_id: "tr-arq-alteracoes", impacted_count: 2 }, error: null }, 300);
    case "create_template_draft": return delay({ data: "t-arq2", error: null }, 300);
    case "generate_project_schedule": case "set_project_area": case "activate_project_service":
      return delay({ data: { tracks_created: 1, tasks_created: 7, tracks_pending: 0 }, error: null }, 300);
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

const RESP: Record<string, [string, string, string]> = { arq: ["p-c1", "Beatriz Nogueira", "clt"], est: ["p-pj", "Camila Rocha", "pj"], int: ["p-c2", "Lucas Ferreira", "clt"] };
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
    services: [svc("arq", "Projeto Arquitetônico", "Arquitetura", "architecture", "active", d(-48)), svc("est", "Projeto Estrutural", "Engenharia", "engineering", "active", d(-48)),
               svc("int", "Design de Interiores", "Interiores", "interiors", "active", d(-48)),
               svc("ele", "Projeto Elétrico", "Engenharia", "engineering", "pending_review", d(-3))],
    team: [
      { id: "tm1", project_role: "project_lead", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-ld", name: "Rafael Andrade", avatar_url: null, employment_type: "clt" } },
      { id: "tm2", project_role: "architecture", employment_type: "clt", active: true, assigned_at: d(-46), user: { id: "p-c1", name: "Beatriz Nogueira", avatar_url: null, employment_type: "clt" } },
      { id: "tm3", project_role: "engineering", employment_type: "pj", active: true, assigned_at: d(-3), user: { id: "p-pj", name: "Camila Rocha", avatar_url: null, employment_type: "pj" } },
      { id: "tm5", project_role: "interiors", employment_type: "clt", active: true, assigned_at: d(-3), user: { id: "p-c2", name: "Lucas Ferreira", avatar_url: null, employment_type: "clt" } },
      { id: "tm6", project_role: "support", employment_type: "pj", active: true, assigned_at: d(-3), user: { id: "p-pj2", name: "Eduardo Prado", avatar_url: null, employment_type: "pj" } },
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


// ---------- Etapa 3: cronograma simulado ----------
const addBiz = (start: string, days: number) => {
  const dt = new Date(`${start}T12:00:00`);
  while (dt.getDay() === 0 || dt.getDay() === 6) dt.setDate(dt.getDate() + 1);
  let left = days - 1;
  while (left > 0) { dt.setDate(dt.getDate() + 1); if (dt.getDay() !== 0 && dt.getDay() !== 6) left--; }
  return dt.toISOString().slice(0, 10);
};
const nextBiz = (date: string) => addBiz(new Date(new Date(`${date}T12:00:00`).getTime() + 86400000).toISOString().slice(0, 10), 1);

const TRACKS: any[] = [];
const TASKS: any[] = [];
const DEPS: any[] = [];
function track(id: string, projectId: string, psId: string, svc: { id: string; name: string; code: string; family: string; fs: number }, status: string, tpl: any, start: string,
  defs: [string, string, number | null, string?, string?][], done = 0, resp: (string | null)[] = []) {
  TRACKS.push({ id, project_id: projectId, project_service_id: psId, status, status_note: status === "awaiting_area" ? "Área necessária para definir cronograma." : null,
    planned_start_date: null, planned_end_date: null, actual_start_date: null, actual_end_date: null, created_at: start + "T10:00:00Z",
    template: tpl, project_service: { id: psId, status: "active", service: { id: svc.id, name: svc.name, code: svc.code, family: { name: svc.family, sort_order: svc.fs } } } });
  let cur = start; let prev: string | null = null; let unknown = false;
  defs.forEach(([code, name, days, type = "fixed", st], i) => {
    const tid = `${id}-${code}`;
    const s0 = unknown ? null : cur;
    const e0 = s0 && days ? addBiz(s0, days) : null;
    if (!e0 && type !== "ongoing") unknown = true;
    const status = st ?? (i < done ? "completed" : i === done ? "in_progress" : i === done + 1 ? "not_started" : "not_started");
    TASKS.push({ id: tid, schedule_track_id: id, project_id: projectId, code, name, description: null, sequence: (i + 1) * 10, duration_type: type,
      planned_duration_days: days, planned_start_date: s0, planned_end_date: e0, actual_start_date: i <= done && status !== "not_started" && s0 ? s0 : null,
      actual_end_date: status === "completed" ? e0 : null, status, status_changed_at: new Date(Date.now() - 5 * 86400000).toISOString(),
      responsible_user_id: resp[i] === undefined ? resp[0] ?? null : resp[i], waiting_reason: status === "waiting_client" ? "Aguardando planta do condomínio" : null,
      notes: null, start_not_before: null, auto_skipped: false, client_visible: true });
    if (prev) DEPS.push({ id: `d-${tid}`, task_id: tid, depends_on_task_id: prev, dependency_type: "finish_to_start", lag_days: 0, source: "template" });
    prev = tid; if (e0) cur = nextBiz(e0);
  });
  const tt = TASKS.filter((t) => t.schedule_track_id === id);
  const tr = TRACKS.find((t) => t.id === id);
  tr.planned_start_date = tt[0]?.planned_start_date ?? null;
  tr.planned_end_date = tt.every((t) => t.planned_end_date) ? tt.at(-1)?.planned_end_date ?? null : null;
}
track("tr-arq", "pr1", "ps-arq", { id: "arq", name: "Projeto Arquitetônico", code: "projeto_arquitetonico", family: "Arquitetura", fs: 10 }, "in_progress",
  { name: "Projeto Arquitetônico", version: 1 }, d(-46),
  [["planejamento", "Planejamento", 20], ["envio_briefing", "Envio do Briefing", 7], ["estudo_preliminar", "Estudo Preliminar", 20], ["alteracoes", "Alterações", 30], ["imagens_3d_video", "Imagens 3D e Vídeo", 10]],
  2, ["p-c1", "p-c1", "p-c1", "p-c1", "p-pj"]);
track("tr-int", "pr1", "ps-int", { id: "int", name: "Design de Interiores", code: "design_interiores", family: "Interiores", fs: 40 }, "in_progress",
  { name: "Design de Interiores — até 500 m²", version: 1 }, d(-12),
  [["planejamento", "Planejamento", 10], ["envio_briefing", "Envio do Briefing", 5, "fixed", "waiting_client"], ["projeto_interiores", "Projeto de Interiores", 10],
   ["alteracao", "Alteração", 15], ["renderizacao", "Renderização", 10], ["detalhamento", "Detalhamento", 15], ["assessoria", "Assessoria", 5]], 1, ["p-c2"]);
track("tr-est", "pr1", "ps-est", { id: "est", name: "Projeto Estrutural", code: "projeto_estrutural", family: "Engenharia", fs: 20 }, "planned",
  { name: "Projeto Estrutural", version: 1 }, d(-46),
  [["briefing_arq_apr_eng", "Briefing Arq + Apr + Eng", 3, "fixed", "completed"], ["producao_arquitetura", "Tempo de Produção da Arquitetura", 25, "dependent", "in_progress"],
   ["revisao_apr_arq_eng", "Revisão APR x ARQ x ENG", 2], ["planejamento", "Planejamento", 10], ["producao_disciplina", "Produção da disciplina", null],
   ["compatibilizacao", "Compatibilização", null], ["executivo", "Executivo", null]], 0, ["p-pj"]);
DEPS.push({ id: "d-x1", task_id: "tr-est-producao_arquitetura", depends_on_task_id: "tr-arq-estudo_preliminar", dependency_type: "finish_to_start", lag_days: 0, source: "template" });
// atraso proposital para a visão geral
{ const t = TASKS.find((x) => x.id === "tr-arq-estudo_preliminar"); t.planned_end_date = d(-2); }

const CHANGES: any[] = [
  { id: "c1", task_id: "tr-arq-estudo_preliminar", change_type: "duration", before: { planned_start_date: d(-30), planned_end_date: d(-6), planned_duration_days: 15 },
    after: { planned_start_date: d(-30), planned_end_date: d(-2), planned_duration_days: 20 }, reason: "Cliente pediu uma rodada extra de layout", impacted_task_ids: ["a", "b", "c"],
    created_at: new Date(Date.now() - 3 * 86400000).toISOString(), author: { name: "Rafael Andrade" } },
  { id: "c2", task_id: "tr-arq-estudo_preliminar", change_type: "status", before: { status: "ready" }, after: { status: "in_progress" }, reason: null, impacted_task_ids: [],
    created_at: new Date(Date.now() - 9 * 86400000).toISOString(), author: { name: "Beatriz Nogueira" } },
];

const LIBRARY: any[] = ["Planejamento", "Envio do Briefing", "Estudo Preliminar", "Alterações", "Imagens 3D e Vídeo", "Projeto Executivo", "Imagens 3D", "Vídeo 3D", "Detalhamento",
  "Renderização", "Compatibilização", "Projeto Legal", "Verificação"].map((name, i) => ({ id: `lib-${i}`, name, description: null, family_id: null,
  default_duration_days: i < 5 ? [20, 7, 20, 30, 10][i] : null, duration_type: "fixed", active: true, created_by: null, created_at: "2026-10-05T12:00:00Z", sort_order: (i + 1) * 10 }));
LIBRARY[LIBRARY.length - 1].active = false;

const FAMILIES = [["arquitetura", "Arquitetura"], ["engenharia", "Engenharia"], ["orcamentos", "Orçamentos"], ["interiores", "Interiores"], ["aprovacoes", "Aprovações e Trâmites"],
  ["b2b_desenvolvimento", "B2B / Desenvolvimento"], ["obra", "Obra"]].map(([code, name], i) => ({ id: `f-${code}`, code, name, sort_order: (i + 1) * 10, active: true }));
const CATALOG = [
  ["arq", "f-arquitetura", "projeto_arquitetonico", "Projeto Arquitetônico", true, true, true],
  ["est", "f-engenharia", "projeto_estrutural", "Projeto Estrutural", true, true, true],
  ["ele", "f-engenharia", "projeto_eletrico", "Projeto Elétrico", true, true, true],
  ["spda", "f-engenharia", "spda", "SPDA", false, true, true],
  ["oe", "f-orcamentos", "orcamento_estimativo", "Orçamento Estimativo", true, true, false],
  ["int", "f-interiores", "design_interiores", "Design de Interiores", true, true, true],
  ["apr", "f-aprovacoes", "aprovacao_projeto_legal", "Aprovação / Projeto Legal", true, true, true],
].map(([id, family_id, code, name, b2c, b2b, has], i) => ({ id, family_id, code, name, description: null, available_for_b2c: b2c, available_for_b2b: b2b,
  has_schedule_template: has, requires_area_rule: code === "design_interiores", sort_order: i * 10, active: true, aliases: code === "projeto_arquitetonico" ? ["Arquitetura"] : [] }));
const tplTasks = (tid: string, defs: [string, string, number | null, string?][]) => defs.map(([code, name, days, type = "fixed"], i) => ({
  id: `${tid}-${code}`, template_id: tid, code, name, description: null, sort_order: (i + 1) * 10, default_duration_days: days, duration_type: type,
  include_if_service_codes: code === "compatibilizacao_interiores" ? ["design_interiores"] : null, client_visible: true, active: true }));
const TEMPLATES: any[] = [
  { id: "t-arq2", service_id: "arq", name: "Projeto Arquitetônico", version: 2, client_type: null, area_min: null, area_max: null, status: "published", active: true,
    notes: "Inclui levantamento no local", published_at: d(-20), created_at: d(-21),
    tasks: tplTasks("t-arq2", [["planejamento", "Planejamento", 20], ["levantamento", "Levantamento no local", 3], ["envio_briefing", "Envio do Briefing", 7],
      ["estudo_preliminar", "Estudo Preliminar", 20], ["alteracoes", "Alterações", 30], ["imagens_3d_video", "Imagens 3D e Vídeo", 10]]) },
  { id: "t-arq1", service_id: "arq", name: "Projeto Arquitetônico", version: 1, client_type: null, area_min: null, area_max: null, status: "archived", active: false,
    notes: "Versão inicial — padrão YouCon", published_at: "2026-10-05", created_at: "2026-10-05", tasks: [] },
  { id: "t-est", service_id: "est", name: "Projeto Estrutural", version: 1, client_type: null, area_min: null, area_max: null, status: "published", active: true,
    notes: "Versão inicial — padrão YouCon", published_at: "2026-10-05", created_at: "2026-10-05",
    tasks: tplTasks("t-est", [["briefing_arq_apr_eng", "Briefing Arq + Apr + Eng", 3], ["producao_arquitetura", "Tempo de Produção da Arquitetura", null, "dependent"],
      ["revisao_apr_arq_eng", "Revisão APR x ARQ x ENG", 2], ["planejamento", "Planejamento", 10], ["producao_disciplina", "Produção da disciplina", null],
      ["compatibilizacao", "Compatibilização", null], ["executivo", "Executivo", null], ["compatibilizacao_interiores", "Compatibilização para interiores", null]]) },
  { id: "t-int1", service_id: "int", name: "Design de Interiores — até 500 m²", version: 1, client_type: null, area_min: null, area_max: 500, status: "published", active: true,
    notes: null, published_at: "2026-10-05", created_at: "2026-10-05",
    tasks: tplTasks("t-int1", [["planejamento", "Planejamento", 10], ["envio_briefing", "Envio do Briefing", 5], ["projeto_interiores", "Projeto de Interiores", 10], ["alteracao", "Alteração", 15]]) },
  { id: "t-int2", service_id: "int", name: "Design de Interiores — acima de 500 m²", version: 1, client_type: null, area_min: 500, area_max: null, status: "published", active: true,
    notes: null, published_at: "2026-10-05", created_at: "2026-10-05",
    tasks: tplTasks("t-int2", [["planejamento", "Planejamento", 15], ["envio_briefing", "Envio do Briefing", 7], ["layout_modelagem", "Layout + Modelagem", 15]]) },
  { id: "t-ele1", service_id: "ele", name: "Projeto Elétrico", version: 1, client_type: null, area_min: null, area_max: null, status: "draft", active: false,
    notes: null, published_at: null, created_at: "2026-10-06",
    tasks: tplTasks("t-ele1", [["planejamento", "Planejamento", 5], ["producao_disciplina", "Produção da disciplina", 15]]) },
];
const TEMPLATE_DEPS: any[] = [{ id: "td1", template_task_id: "t-est-producao_arquitetura", predecessor_task_id: null, predecessor_service_code: "projeto_arquitetonico", predecessor_task_code: "estudo_preliminar", active: true }];
// Arquitetura v2: fase 5 com "Alterações" e "Imagens 3D e Vídeo" simultâneas
const seqDep = (tid: string, a: string, b: string) => TEMPLATE_DEPS.push({ id: `${tid}-${a}-${b}`, template_task_id: `${tid}-${a}`, predecessor_task_id: `${tid}-${b}`, predecessor_service_code: null, predecessor_task_code: null, active: true });
seqDep("t-arq2", "levantamento", "planejamento"); seqDep("t-arq2", "envio_briefing", "levantamento"); seqDep("t-arq2", "estudo_preliminar", "envio_briefing");
seqDep("t-arq2", "alteracoes", "estudo_preliminar");
["revisao_apr_arq_eng", "planejamento", "producao_disciplina", "compatibilizacao", "executivo", "compatibilizacao_interiores"].forEach((c, i, a) =>
  seqDep("t-est", c, i === 0 ? "producao_arquitetura" : a[i - 1]));
seqDep("t-est", "producao_arquitetura", "briefing_arq_apr_eng");
seqDep("t-int1", "envio_briefing", "planejamento"); seqDep("t-int1", "projeto_interiores", "envio_briefing"); seqDep("t-int1", "alteracao", "projeto_interiores");
seqDep("t-int2", "envio_briefing", "planejamento"); seqDep("t-int2", "layout_modelagem", "envio_briefing");
seqDep("t-ele1", "producao_disciplina", "planejamento"); seqDep("t-arq2", "imagens_3d_video", "estudo_preliminar");

PROJECTS.forEach((p) => p.services.forEach((x: any) => {
  const r = p.id === "pr1" ? RESP[x.service.id] : undefined;
  x.responsible_user_id = r?.[0] ?? null;
  x.responsible = r ? { id: r[0], name: r[1], avatar_url: null, employment_type: r[2] } : null;
  x.service.family.sort_order = x.service.family.name === "Arquitetura" ? 10 : x.service.family.name === "Engenharia" ? 20 : 40;
}));

function alertsView() {
  const today = new Date().toISOString().slice(0, 10);
  return TASKS.map((t) => {
    const p = PROJECTS.find((x) => x.id === t.project_id);
    const tr = TRACKS.find((x) => x.id === t.schedule_track_id);
    const due = t.planned_end_date ? Math.round((new Date(`${t.planned_end_date}T12:00:00`).getTime() - new Date(`${today}T12:00:00`).getTime()) / 86400000) : null;
    const open = !["completed", "cancelled"].includes(t.status);
    return { task_id: t.id, project_id: t.project_id, task_name: t.name, status: t.status, responsible_user_id: t.responsible_user_id,
      planned_start_date: t.planned_start_date, planned_end_date: t.planned_end_date, project_name: p?.name, project_code: p?.code, service_name: tr?.project_service.service.name,
      due_in_days: due, overdue_days: open && due != null && due < 0 ? -due : null, waiting_days: ["waiting_client", "waiting_dependency", "waiting_third_party"].includes(t.status) ? 5 : null,
      is_overdue: open && due != null && due < 0, is_blocked: ["waiting_dependency", "waiting_third_party"].includes(t.status), is_waiting_client: t.status === "waiting_client",
      is_unassigned: open && !t.responsible_user_id };
  });
}

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
  if (table === "project_schedule_tracks") return TRACKS;
  if (table === "project_tasks") return TASKS;
  if (table === "task_dependencies") return DEPS;
  if (table === "task_changes") return CHANGES;
  if (table === "task_alerts") return alertsView().filter((a) => {
    if (p.role === "collaborator") return a.responsible_user_id === p.id;
    return true;
  });
  if (table === "task_library") return LIBRARY;
  if (table === "service_families") return FAMILIES;
  if (table === "schedule_templates") return TEMPLATES;
  if (table === "template_task_dependencies") return TEMPLATE_DEPS;
  if (table === "template_tasks") return TEMPLATES.filter((t) => t.active).flatMap((t) => t.tasks.map((x: any) => ({ ...x,
    template: { active: true, service: CATALOG.find((c) => c.id === t.service_id) } })));
  if (table === "services") return CATALOG;
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
  let payload: any = null;
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (col: string, val: any) => { if (!col.includes(".")) filters.push([col, val]); return q; },
    in: () => q,
    not: (col: string, _op: string, val: string) => { const vals = val.replace(/[()]/g, "").split(","); filters.push([col, { notIn: vals }]); return q; },
    limit: () => q,
    single: () => { single = true; return q; },
    maybeSingle: () => { single = true; return q; },
    insert: (row: any) => { mode = "insert"; payload = row; return q; },
    update: () => { mode = "update"; return q; },
    then: (resolve: any, reject: any) => {
      let rows = visibleRows(table).filter((r) => filters.every(([c, v]) => (v && typeof v === "object" && v.notIn) ? !v.notIn.includes(r[c]) : r[c] === v));
      if (mode === "insert" && table === "task_library" && single) {
        const item = { id: `lib-new-${Date.now()}`, description: null, family_id: null, active: true, created_at: new Date().toISOString(), sort_order: 9999, ...payload };
        LIBRARY.push(item);
        return delay({ data: item, error: null }).then(resolve, reject);
      }
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
