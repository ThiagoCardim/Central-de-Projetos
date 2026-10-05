import type {
  ClientType, EmploymentType, ProjectStatus, RecordStatus, TaskAlert, TaskStatus, TenantType, UserRole,
} from "@/types/domain";

export const ROLE_LABEL: Record<UserRole, string> = {
  client: "Cliente",
  collaborator: "Colaborador",
  leader: "Líder",
  unit_admin: "ADM Unidade",
  global_admin: "ADM Global",
};

export const ROLE_DESCRIPTION: Record<UserRole, string> = {
  client: "Acompanha somente os projetos do próprio cliente.",
  collaborator: "Vê e atualiza as etapas dos projetos em que está na equipe.",
  leader: "Atribui equipe, edita cronogramas e acompanha prazos da unidade.",
  unit_admin: "Administra usuários, clientes e projetos desta unidade.",
  global_admin: "Administra a rede YouCon: todas as unidades, templates e distribuição.",
};

export const EMPLOYMENT_LABEL: Record<EmploymentType, string> = { clt: "CLT", pj: "PJ" };
export const CLIENT_TYPE_LABEL: Record<ClientType, string> = { b2c: "B2C", b2b: "B2B" };
export const RECORD_STATUS_LABEL: Record<RecordStatus, string> = { ativo: "Ativo", inativo: "Inativo" };
export const TENANT_TYPE_LABEL: Record<TenantType, string> = { franqueadora: "Franqueadora", franquia: "Franquia" };

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  awaiting_allocation: "Aguardando distribuição",
  awaiting_team_assignment: "Aguardando equipe",
  in_progress: "Em andamento",
  on_hold: "Pausado",
  completed: "Concluído",
  cancelled: "Cancelado",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Não iniciada",
  waiting_dependency: "Aguardando etapa anterior",
  ready: "Pronta para iniciar",
  in_progress: "Em andamento",
  waiting_client: "Aguardando cliente",
  waiting_third_party: "Aguardando terceiro",
  completed: "Concluída",
  overdue: "Atrasada",
  cancelled: "Cancelada",
};

export type Tone = "neutral" | "brand" | "danger" | "warning" | "success";

export const TASK_STATUS_TONE: Record<TaskStatus, Tone> = {
  not_started: "neutral",
  waiting_dependency: "neutral",
  ready: "brand",
  in_progress: "brand",
  waiting_client: "warning",
  waiting_third_party: "warning",
  completed: "success",
  overdue: "danger",
  cancelled: "neutral",
};

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WEEKDAY = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });

/** Datas do banco (YYYY-MM-DD) são datas civis: evita deslocamento de fuso. */
function parseDate(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
}

export function formatDate(value: string | null | undefined, full = false): string {
  if (!value) return "—";
  const dt = parseDate(value);
  const base = `${String(dt.getDate()).padStart(2, "0")} ${MONTHS[dt.getMonth()]}`;
  return full ? `${base} ${dt.getFullYear()}` : base;
}

export function formatToday(): string {
  const s = WEEKDAY.format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : parts[0][1] ?? "";
  return (first + last).toUpperCase();
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function slugify(value: string): string {
  return value
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Frase de alerta operacional para uma etapa (seção 88 do escopo). */
export function alertPhrase(a: TaskAlert): { text: string; tone: Tone } {
  if (a.is_overdue && a.overdue_days != null) {
    return { text: `Atrasada ${plural(a.overdue_days, "dia", "dias")}`, tone: "danger" };
  }
  if (a.is_blocked && a.waiting_days != null) {
    return { text: `Bloqueada há ${plural(a.waiting_days, "dia", "dias")}`, tone: "warning" };
  }
  if (a.is_waiting_client && a.waiting_days != null) {
    return { text: `Aguardando cliente há ${plural(a.waiting_days, "dia", "dias")}`, tone: "warning" };
  }
  if (a.due_in_days === 0) return { text: "Vence hoje", tone: "brand" };
  if (a.due_in_days === 1) return { text: "Vence amanhã", tone: "brand" };
  if (a.due_in_days != null && a.due_in_days > 1 && a.due_in_days <= 7) {
    return { text: `Vence em ${a.due_in_days} dias`, tone: "neutral" };
  }
  if (a.is_unassigned) return { text: "Sem responsável", tone: "warning" };
  return { text: a.planned_end_date ? `Prazo ${formatDate(a.planned_end_date)}` : "Sem prazo definido", tone: "neutral" };
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
