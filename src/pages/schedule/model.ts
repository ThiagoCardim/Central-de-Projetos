// Regras de leitura do cronograma (derivadas dos dados; a fonte da verdade é o banco).
import type { ScheduleTask, ScheduleTrack, TaskDependency, TaskStatus, TrackStatus } from "@/types/domain";
import type { Tone } from "@/utils/format";

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const CLOSED: TaskStatus[] = ["completed", "cancelled"];
export const isClosed = (t: ScheduleTask) => CLOSED.includes(t.status);
export const isOverdue = (t: ScheduleTask, today = todayISO()) => !isClosed(t) && !!t.planned_end_date && t.planned_end_date < today;
export const isBlocked = (t: ScheduleTask) => t.status === "waiting_dependency" || t.status === "waiting_third_party";
export const isWaitingClient = (t: ScheduleTask) => t.status === "waiting_client";
export const isStarted = (t: ScheduleTask) => !!t.actual_start_date;

/** Status exibido: atraso é calculado pelas datas, não é status manual. */
export function displayStatus(t: ScheduleTask, today = todayISO()): TaskStatus {
  if (isOverdue(t, today) && !isBlocked(t) && !isWaitingClient(t)) return "overdue";
  return t.status;
}

export const TRACK_STATUS_LABEL: Record<TrackStatus, string> = {
  no_template: "Sem cronograma padrão",
  awaiting_area: "Aguardando área",
  planned: "Planejado",
  in_progress: "Em andamento",
  completed: "Concluído",
  cancelled: "Cancelado",
};
export const TRACK_STATUS_TONE: Record<TrackStatus, Tone> = {
  no_template: "neutral", awaiting_area: "warning", planned: "neutral", in_progress: "brand", completed: "success", cancelled: "neutral",
};

export const DURATION_TYPE_LABEL = {
  fixed: "Prazo fixo",
  dependent: "Depende de outro serviço",
  external: "Prazo de terceiros",
  ongoing: "Contínua",
} as const;

export function durationText(t: Pick<ScheduleTask, "duration_type" | "planned_duration_days">): string {
  if (t.duration_type === "ongoing") return "Contínua";
  if (t.planned_duration_days) return `${t.planned_duration_days} ${t.planned_duration_days === 1 ? "dia útil" : "dias úteis"}`;
  if (t.duration_type === "external") return "Prazo de terceiros";
  if (t.duration_type === "dependent") return "Conforme outro serviço";
  return "Prazo a definir";
}

/** Progresso por etapas concluídas (canceladas não contam). */
export function progressOf(tasks: ScheduleTask[]): number {
  const valid = tasks.filter((t) => t.status !== "cancelled");
  if (valid.length === 0) return 0;
  return Math.round((valid.filter((t) => t.status === "completed").length / valid.length) * 100);
}

export function forecastOf(tracks: ScheduleTrack[], tasks: ScheduleTask[]): { date: string | null; partial: boolean } {
  const open = tasks.filter((t) => t.status !== "cancelled");
  const ends = open.map((t) => t.actual_end_date ?? t.planned_end_date).filter(Boolean) as string[];
  const partial = open.some((t) => !t.planned_end_date && t.duration_type !== "ongoing") ||
    tracks.some((tr) => tr.status === "no_template" || tr.status === "awaiting_area");
  return { date: ends.length ? ends.sort().at(-1)! : null, partial };
}

export type QuickFilter = "all" | "mine" | "overdue" | "blocked" | "waiting_client" | "unassigned";
export const QUICK_FILTERS: { value: QuickFilter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "mine", label: "Minhas etapas" },
  { value: "overdue", label: "Atrasadas" },
  { value: "blocked", label: "Bloqueadas" },
  { value: "waiting_client", label: "Aguardando cliente" },
  { value: "unassigned", label: "Sem responsável" },
];

export interface ScheduleFilters { quick: QuickFilter; service: string; responsible: string; step: string; showDone: boolean }

/** Chave do filtro por etapa: o mesmo nome em serviços diferentes conta como a mesma etapa. */
export const stepFilterKey = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export function matchesFilters(t: ScheduleTask, f: ScheduleFilters, me: string | null, today = todayISO()): boolean {
  if (f.service && t.schedule_track_id !== f.service) return false;
  if (f.step && stepFilterKey(t.name) !== f.step) return false;
  if (f.responsible === "none" && t.responsible_user_id) return false;
  if (f.responsible && f.responsible !== "none" && t.responsible_user_id !== f.responsible) return false;
  if (!f.showDone && t.status === "cancelled" && t.auto_skipped) return false;
  switch (f.quick) {
    case "mine": return t.responsible_user_id === me;
    case "overdue": return isOverdue(t, today);
    case "blocked": return isBlocked(t);
    case "waiting_client": return isWaitingClient(t);
    case "unassigned": return !t.responsible_user_id && !isClosed(t);
    default: return true;
  }
}

export function serviceName(tr: ScheduleTrack | undefined): string {
  return tr?.project_service?.service?.name ?? "Serviço";
}

/** Ordena trilhas pela família e ordem de criação. */
export function sortTracks(tracks: ScheduleTrack[]): ScheduleTrack[] {
  return [...tracks].sort((a, b) =>
    (a.project_service?.service?.family?.sort_order ?? 99) - (b.project_service?.service?.family?.sort_order ?? 99)
    || a.created_at.localeCompare(b.created_at));
}

export function predecessorsOf(taskId: string, deps: TaskDependency[]) {
  return deps.filter((d) => d.task_id === taskId);
}
export function successorsOf(taskId: string, deps: TaskDependency[]) {
  return deps.filter((d) => d.depends_on_task_id === taskId);
}

/** Ações de status disponíveis (o banco revalida). */
export interface StatusAction { status: TaskStatus; label: string; needsReason?: boolean; managerOnly?: boolean; variant?: "primary" | "secondary" | "ghost" | "danger-ghost" }
export function statusActions(t: ScheduleTask, manager: boolean): StatusAction[] {
  if (t.status === "cancelled") {
    return manager && !t.auto_skipped ? [{ status: "not_started", label: "Reativar etapa", managerOnly: true, variant: "secondary" }] : [];
  }
  const list: StatusAction[] = [];
  switch (t.status) {
    case "not_started":
    case "ready":
      list.push({ status: "in_progress", label: "Iniciar etapa", variant: "primary" });
      break;
    case "in_progress":
      list.push({ status: "completed", label: "Concluir etapa", variant: "primary" });
      list.push({ status: "waiting_client", label: "Aguardando cliente", needsReason: true, variant: "secondary" });
      list.push({ status: "waiting_third_party", label: "Aguardando terceiro", needsReason: true, variant: "secondary" });
      list.push({ status: "waiting_dependency", label: "Registrar impedimento", needsReason: true, variant: "secondary" });
      break;
    case "waiting_client":
    case "waiting_third_party":
    case "waiting_dependency":
      list.push({ status: "in_progress", label: "Retomar", variant: "primary" });
      list.push({ status: "completed", label: "Concluir etapa", variant: "secondary" });
      break;
    case "completed":
      break; // reabrir tem fluxo próprio (prazo do retrabalho + motivo), no painel da etapa
  }
  if (manager && t.status !== "completed") {
    list.push({ status: "cancelled", label: "Cancelar etapa", needsReason: true, managerOnly: true, variant: "danger-ghost" });
  }
  return list;
}

export const REASON_PLACEHOLDER: Partial<Record<TaskStatus, string>> = {
  waiting_client: "O que o cliente precisa enviar ou aprovar?",
  waiting_third_party: "Quem é o terceiro e o que está pendente?",
  waiting_dependency: "O que está impedindo o andamento?",
  cancelled: "Por que esta etapa não será executada?",
};

export const CHANGE_LABEL: Record<string, string> = {
  reschedule: "Início reprogramado",
  duration: "Duração alterada",
  responsible: "Responsável alterado",
  status: "Status alterado",
  dependency: "Dependência alterada",
  created: "Cronograma gerado",
  recalculated: "Recalculado",
};
