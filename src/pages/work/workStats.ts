import type { TeamPerson, WorkItem } from "@/types/domain";

/* Cálculos das tarefas do dia, usados em Minhas tarefas e na página inicial. */
const parse = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
export const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return toIso(d); };
export const diffDays = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
/** Dia (local) em que a tarefa foi marcada como feita. */
export const doneDay = (w: WorkItem) => (w.done_at ? toIso(new Date(w.done_at)) : null);

/** Minhas tarefas do dia: para hoje, atrasadas e feitas hoje. */
export function myDayStats(items: WorkItem[], today: string) {
  const open = items.filter((w) => !w.done_at);
  const late = open.filter((w) => w.due_date < today);
  const dueToday = open.filter((w) => w.due_date === today);
  const doneToday = items.filter((w) => doneDay(w) === today);
  const fromLead = open.filter((w) => !!w.assigned_by && w.due_date <= today).length;
  return { late, dueToday, doneToday, fromLead, next7: open.filter((w) => w.due_date > today && w.due_date <= addDays(today, 7)).length };
}

/** Tarefas atribuídas à equipe: totais e resumo por pessoa. */
export function teamStats(items: WorkItem[], today: string) {
  const since30 = addDays(today, -30);
  const open = items.filter((w) => !w.done_at);
  const done30 = items.filter((w) => w.done_at && (doneDay(w) ?? "") >= since30);
  const onTime = done30.filter((w) => (doneDay(w) ?? "") <= w.due_date).length;
  const people = new Map<string, { p: TeamPerson; open: number; late: number; done: number; total: number }>();
  items.forEach((w) => {
    if (!w.owner) return;
    const r = people.get(w.owner.id) ?? { p: w.owner, open: 0, late: 0, done: 0, total: 0 };
    r.total += 1;
    if (w.done_at) r.done += 1; else { r.open += 1; if (w.due_date < today) r.late += 1; }
    people.set(w.owner.id, r);
  });
  return {
    open: open.length,
    today: open.filter((w) => w.due_date === today).length,
    late: open.filter((w) => w.due_date < today).length,
    done30: done30.length,
    onTimePct: done30.length ? Math.round((onTime / done30.length) * 100) : null,
    people: [...people.values()].sort((a, b) => b.late - a.late || b.open - a.open || a.p.name.localeCompare(b.p.name)),
  };
}
