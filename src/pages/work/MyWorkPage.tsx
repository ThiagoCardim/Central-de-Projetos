import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { useNavigate, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import {
  Badge, Button, Card, EmptyState, Input, LoadError, MetricCard, ProgressBar, Segmented, Skeleton, StatusBadge, Tabs,
} from "@/components/ui/primitives";
import { ConfirmDialog, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { OptionPicker } from "@/components/ui/OptionPicker";
import type { MyStep, TaskStatus, WorkItem } from "@/types/domain";
import { cx, formatDate, formatToday, plural } from "@/utils/format";
import { todayISO } from "@/pages/schedule/model";

/* ==========================================================================
   Datas e leitura das etapas
   ========================================================================== */
const parse = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
const WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const MONTH_FMT = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const DAY_FMT = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });

type Bucket = "overdue" | "in_progress" | "waiting" | "upcoming" | "done";
const WAITING: TaskStatus[] = ["waiting_client", "waiting_third_party", "waiting_dependency"];
const isDone = (s: MyStep) => s.status === "completed";
const stepStart = (s: MyStep) => s.actual_start_date ?? s.planned_start_date;
/** Fim para a agenda: atrasada e ainda aberta segue até hoje. */
const stepEnd = (s: MyStep) => {
  if (isDone(s)) return s.actual_end_date ?? s.planned_end_date;
  const t = todayISO();
  return s.planned_end_date && s.planned_end_date < t ? t : s.planned_end_date;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isOverdue = (s: MyStep, today: string) => !isDone(s) && !!s.planned_end_date && s.planned_end_date < today;

function bucketOf(s: MyStep, today: string): Bucket {
  if (isDone(s)) return "done";
  if (WAITING.includes(s.status)) return "waiting";
  if (isOverdue(s, today)) return "overdue";
  if (s.status === "in_progress" || s.actual_start_date) return "in_progress";
  return "upcoming";
}
const shownStatus = (s: MyStep, today: string): TaskStatus => (isOverdue(s, today) && !WAITING.includes(s.status) ? "overdue" : s.status);

/** Quanto do prazo já passou (0–100). */
function timeProgress(s: MyStep, today: string): number {
  if (isDone(s)) return 100;
  const a = stepStart(s); const b = s.planned_end_date;
  if (!a || !b || !s.actual_start_date) return 0;
  const total = diffDays(a, b) + 1;
  return Math.max(0, Math.min(100, Math.round(((diffDays(a, today) + 1) / total) * 100)));
}

function deadline(s: MyStep, today: string): { text: string; tone: "danger" | "warning" | "neutral" | "success" } {
  if (isDone(s)) {
    const end = s.actual_end_date; const plan = s.planned_end_date;
    if (end && plan && end < plan) return { text: `Concluída em ${formatDate(end)} · ${plural(diffDays(end, plan), "dia", "dias")} antes`, tone: "success" };
    return { text: end ? `Concluída em ${formatDate(end)}` : "Concluída", tone: "success" };
  }
  if (!s.planned_end_date) return { text: "Prazo a definir", tone: "neutral" };
  const d = diffDays(today, s.planned_end_date);
  if (d < 0) return { text: `Atrasada há ${plural(-d, "dia", "dias")}`, tone: "danger" };
  if (d === 0) return { text: "Entrega hoje", tone: "warning" };
  if (d === 1) return { text: "Entrega amanhã", tone: "warning" };
  return { text: `Faltam ${d} dias`, tone: d <= 3 ? "warning" : "neutral" };
}

/* ==========================================================================
   Página
   ========================================================================== */
type Tab = "hoje" | "etapas" | "agenda";

export function MyWorkPage() {
  useDocumentTitle("Minhas tarefas");
  const toast = useToast();
  const navigate = useNavigate();
  const initialTab = useSearchParam("aba") as Tab | null;
  const [tab, setTab] = useState<Tab>(initialTab && ["hoje", "etapas", "agenda"].includes(initialTab) ? initialTab : "hoje");
  const steps = useAsync(() => api.mySteps(), []);
  const itemsQ = useAsync(() => api.listWorkItems(), []);
  const [items, setItems] = useState<WorkItem[]>([]);
  useEffect(() => { if (itemsQ.data) setItems(itemsQ.data); }, [itemsQ.data]);
  const [confirming, setConfirming] = useState<MyStep | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const today = todayISO();

  const all = steps.data ?? [];
  const open = all.filter((s) => !isDone(s));
  const counts = {
    overdue: open.filter((s) => isOverdue(s, today)).length + items.filter((i) => !i.done_at && i.due_date < today).length,
    today: items.filter((i) => !i.done_at && i.due_date === today).length + open.filter((s) => s.planned_end_date === today).length,
    doing: open.filter((s) => s.status === "in_progress").length,
    week: open.filter((s) => s.planned_end_date && s.planned_end_date >= today && s.planned_end_date <= addDays(today, 7)).length,
    done30: all.filter((s) => isDone(s) && s.actual_end_date && s.actual_end_date >= addDays(today, -30)).length,
  };

  const openStep = (s: { id: string; project_id: string }) => navigate(`/projetos/${s.project_id}/cronograma?etapa=${s.id}`);
  async function startStep(s: MyStep) {
    setBusy(s.id);
    try { await api.setTaskStatus(s.id, "in_progress"); toast(`“${s.name}” iniciada.`); void steps.reload(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function completeStep(s: MyStep) {
    setBusy(s.id);
    try {
      const r = await api.setTaskStatus(s.id, "completed");
      toast(r.impacted_count ? `Etapa concluída. ${plural(r.impacted_count, "etapa seguinte recalculada", "etapas seguintes recalculadas")}.` : "Etapa concluída.");
      setConfirming(null); void steps.reload();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }

  // Tarefas do dia: atualização imediata na tela, gravação em seguida.
  const items$ = {
    add: async (input: { title: string; due_date: string; project_task_id?: string | null }) => {
      try { const it = await api.addWorkItem(input); setItems((xs) => [...xs, it]); return true; }
      catch (e) { toast((e as Error).message, "error"); return false; }
    },
    toggle: async (it: WorkItem) => {
      const done_at = it.done_at ? null : new Date().toISOString();
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, done_at } : x)));
      try { await api.updateWorkItem(it.id, { done_at }); if (done_at) toast("Tarefa feita."); }
      catch (e) { setItems((xs) => xs.map((x) => (x.id === it.id ? it : x))); toast((e as Error).message, "error"); }
    },
    move: async (it: WorkItem, due_date: string) => {
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, due_date } : x)));
      try { await api.updateWorkItem(it.id, { due_date }); }
      catch (e) { setItems((xs) => xs.map((x) => (x.id === it.id ? it : x))); toast((e as Error).message, "error"); }
    },
    remove: async (it: WorkItem) => {
      setItems((xs) => xs.filter((x) => x.id !== it.id));
      try { await api.deleteWorkItem(it.id); }
      catch (e) { setItems((xs) => [...xs, it]); toast((e as Error).message, "error"); }
    },
  };

  const stepActions = (s: MyStep) => (
    <StepActions step={s} busy={busy === s.id} onStart={() => startStep(s)} onComplete={() => setConfirming(s)} onOpen={() => openStep(s)} />
  );
  const error = steps.error ?? itemsQ.error;
  const loading = (steps.loading && !steps.data) || (itemsQ.loading && !itemsQ.data);

  return (
    <div className="page mywork">
      <PageHead title="Minhas tarefas" subtitle={<>{formatToday()} <span className="sep" aria-hidden="true" /> Tudo o que está sob sua responsabilidade</>} />
      <div className="metrics">
        <MetricCard label="Atrasadas" value={counts.overdue} tone={counts.overdue ? "danger" : "quiet"} hint="Etapas e tarefas" onClick={() => setTab("hoje")} />
        <MetricCard label="Para hoje" value={counts.today} tone={counts.today ? "brand" : "quiet"} hint="Tarefas e entregas" onClick={() => setTab("hoje")} />
        <MetricCard label="Etapas em andamento" value={counts.doing} onClick={() => setTab("etapas")} />
        <MetricCard label="Entregas em 7 dias" value={counts.week} onClick={() => setTab("agenda")} />
        <MetricCard label="Concluídas (30 dias)" value={counts.done30} tone="quiet" onClick={() => setTab("etapas")} />
      </div>
      <Tabs<Tab> label="Visões" value={tab} onChange={setTab} tabs={[
        { value: "hoje", label: "Hoje", count: counts.overdue + counts.today || undefined },
        { value: "etapas", label: "Minhas etapas", count: open.length || undefined },
        { value: "agenda", label: "Agenda" },
      ]} />
      {error ? <LoadError message={error} onRetry={() => { void steps.reload(); void itemsQ.reload(); }} /> :
        loading ? <><Skeleton height={120} radius={16} /><Skeleton height={260} radius={16} /></> : (
          <>
            {tab === "hoje" && <TodayView steps={all} items={items} today={today} actions={items$} stepActions={stepActions} onOpen={openStep} />}
            {tab === "etapas" && <StepsView steps={all} today={today} stepActions={stepActions} onOpen={openStep} />}
            {tab === "agenda" && <AgendaView steps={all} items={items} today={today} actions={items$} onOpen={openStep} />}
          </>
        )}
      <ConfirmDialog open={!!confirming} title={`Concluir “${confirming?.name ?? ""}”?`}
        message={`${confirming?.project_code ?? confirming?.project_name ?? ""} · ${confirming?.service_name ?? ""}. As etapas seguintes são liberadas e o cronograma do projeto é recalculado.`}
        confirmLabel="Concluir etapa" loading={!!confirming && busy === confirming.id}
        onCancel={() => setConfirming(null)} onConfirm={() => confirming && completeStep(confirming)} />
    </div>
  );
}

type ItemActions = {
  add: (i: { title: string; due_date: string; project_task_id?: string | null }) => Promise<boolean>;
  toggle: (i: WorkItem) => void; move: (i: WorkItem, d: string) => void; remove: (i: WorkItem) => void;
};

function StepActions({ step, busy, onStart, onComplete, onOpen }: { step: MyStep; busy: boolean; onStart: () => void; onComplete: () => void; onOpen: () => void }) {
  const canStart = step.status === "not_started" || step.status === "ready";
  const canComplete = step.status === "in_progress" || WAITING.includes(step.status);
  return (
    <div className="mw-actions">
      {canStart && <Button size="sm" variant="secondary" icon="target" loading={busy} onClick={onStart}>Iniciar</Button>}
      {canComplete && <Button size="sm" icon="check" loading={busy} onClick={onComplete}>Concluir</Button>}
      <Button size="sm" variant="ghost" onClick={onOpen}>Abrir</Button>
    </div>
  );
}

/* ==========================================================================
   Hoje
   ========================================================================== */
function TodayView({ steps, items, today, actions, stepActions, onOpen }: {
  steps: MyStep[]; items: WorkItem[]; today: string; actions: ItemActions;
  stepActions: (s: MyStep) => ReactNode; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  const stepById = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const open = steps.filter((s) => !isDone(s));
  const pending = items.filter((i) => !i.done_at && i.due_date < today);
  const todays = items.filter((i) => !i.done_at && i.due_date === today);
  const doneToday = items.filter((i) => i.done_at && i.done_at.slice(0, 10) === today);
  const next = items.filter((i) => !i.done_at && i.due_date > today && i.due_date <= addDays(today, 7));

  const overdueSteps = open.filter((s) => isOverdue(s, today));
  const dueToday = open.filter((s) => s.planned_end_date === today);
  const doing = open.filter((s) => bucketOf(s, today) === "in_progress" && s.planned_end_date !== today);
  const startable = open.filter((s) => (s.status === "ready" || s.status === "not_started") && (s.planned_start_date ?? "9999") <= addDays(today, 2));
  const todayIds = new Set(items.filter((i) => !i.done_at && i.due_date === today).map((i) => i.project_task_id));
  const addToDay = (s: MyStep) => actions.add({ title: `Avançar em ${s.name}`, due_date: today, project_task_id: s.id });

  return (
    <div className="home__grid">
      <div className="home__main">
        <Card title={`Tarefas do dia · ${DAY_FMT.format(parse(today))}`}>
          <QuickAdd steps={open} today={today} onAdd={actions.add} />
          {pending.length > 0 && (
            <ItemGroup title="Pendentes de dias anteriores" tone="danger" count={pending.length}>
              {pending.map((i) => <ItemRow key={i.id} item={i} step={stepById.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen} late />)}
            </ItemGroup>
          )}
          <ItemGroup title="Para hoje" count={todays.length}>
            {todays.length === 0 && pending.length === 0 && doneToday.length === 0 ? (
              <EmptyState compact icon="checkCircle" title="Nada planejado para hoje ainda."
                text="Adicione acima o que você vai fazer, ou use “Adicionar ao meu dia” nas etapas ao lado." />
            ) : todays.length === 0 ? <p className="subtext mw-empty">Tudo o que era para hoje está feito.</p> :
              todays.map((i) => <ItemRow key={i.id} item={i} step={stepById.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen} />)}
          </ItemGroup>
          {doneToday.length > 0 && (
            <ItemGroup title="Feitas hoje" tone="success" count={doneToday.length}>
              {doneToday.map((i) => <ItemRow key={i.id} item={i} step={stepById.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen} />)}
            </ItemGroup>
          )}
          {next.length > 0 && (
            <details className="mw-next">
              <summary>Próximos 7 dias · {next.length}</summary>
              {next.map((i) => <ItemRow key={i.id} item={i} step={stepById.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen} />)}
            </details>
          )}
        </Card>
      </div>
      <aside className="home__side">
        <Card title="Etapas que pedem ação" flush>
          {overdueSteps.length + dueToday.length + doing.length + startable.length === 0 ? (
            <EmptyState compact icon="checkCircle" title="Nenhuma etapa pedindo ação agora." />
          ) : (
            <div className="mw-side">
              <StepMiniGroup title="Atrasadas" tone="danger" steps={overdueSteps} today={today} actions={stepActions} onAdd={addToDay} inDay={todayIds} onOpen={onOpen} />
              <StepMiniGroup title="Entrega hoje" tone="warning" steps={dueToday} today={today} actions={stepActions} onAdd={addToDay} inDay={todayIds} onOpen={onOpen} />
              <StepMiniGroup title="Em andamento" steps={doing} today={today} actions={stepActions} onAdd={addToDay} inDay={todayIds} onOpen={onOpen} />
              <StepMiniGroup title="Prontas para começar" steps={startable} today={today} actions={stepActions} onAdd={addToDay} inDay={todayIds} onOpen={onOpen} />
            </div>
          )}
        </Card>
      </aside>
    </div>
  );
}

function QuickAdd({ steps, today, onAdd, date }: { steps: MyStep[]; today: string; onAdd: ItemActions["add"]; date?: string }) {
  const [title, setTitle] = useState("");
  const [step, setStep] = useState("");
  const [due, setDue] = useState(date ?? today);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (date) setDue(date); }, [date]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    if (await onAdd({ title, due_date: due, project_task_id: step || null })) { setTitle(""); setStep(""); }
    setBusy(false);
  }
  return (
    <form className="mw-add" onSubmit={submit}>
      <Input aria-label="Nova tarefa" placeholder="O que você vai fazer?" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      <div className="mw-add__row">
        <OptionPicker label="Etapa ligada (opcional)" value={step} clearable placeholder="Ligar a uma etapa (opcional)" searchPlaceholder="Buscar etapa ou projeto"
          options={steps.map((s) => ({ value: s.id, label: s.name, group: `${s.project_code ?? ""} ${s.project_name}`.trim(), keywords: s.service_name }))}
          onChange={setStep} />
        {!date && <Input aria-label="Data" type="date" value={due} min={today} onChange={(e) => setDue(e.target.value || today)} />}
        <Button type="submit" icon="plus" loading={busy} disabled={!title.trim()}>Adicionar</Button>
      </div>
    </form>
  );
}

function ItemGroup({ title, count, tone, children }: { title: string; count: number; tone?: "danger" | "success"; children: ReactNode }) {
  return (
    <section className={cx("mw-group", tone && `mw-group--${tone}`)}>
      <h3 className="mw-group__title">{title}{count > 0 && <span className="muted"> · {count}</span>}</h3>
      <ul className="mw-items">{children}</ul>
    </section>
  );
}

function ItemRow({ item, step, today, actions, onOpen, late }: {
  item: WorkItem; step?: MyStep; today: string; actions: ItemActions; onOpen: (s: { id: string; project_id: string }) => void; late?: boolean;
}) {
  const done = !!item.done_at;
  return (
    <li className={cx("mw-item", done && "is-done", late && "is-late")}>
      <button type="button" className={cx("mw-check", done && "is-on")} aria-pressed={done}
        aria-label={done ? `Desmarcar “${item.title}”` : `Marcar “${item.title}” como feita`} onClick={() => actions.toggle(item)}>
        {done && <Icon name="check" size={14} />}
      </button>
      <span className="mw-item__main">
        <span className="mw-item__title">{item.title}</span>
        <span className="mw-item__meta">
          {late && <span className="mw-late">era para {formatDate(item.due_date)} · {plural(diffDays(item.due_date, today), "dia", "dias")} de atraso</span>}
          {!late && item.due_date !== today && !done && <span>{formatDate(item.due_date)}</span>}
          {step && (
            <button type="button" className="mw-link" onClick={() => onOpen(step)}>
              {step.project_code ?? step.project_name} · {step.name}
            </button>
          )}
        </span>
      </span>
      <span className="mw-item__side">
        {!done && item.due_date !== today && <Button size="sm" variant="ghost" onClick={() => actions.move(item, today)}>Para hoje</Button>}
        {!done && item.due_date <= today && <Button size="sm" variant="ghost" onClick={() => actions.move(item, addDays(today, 1))}>Amanhã</Button>}
        <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => actions.remove(item)}>Excluir</Button>
      </span>
    </li>
  );
}

function StepMiniGroup({ title, tone, steps, today, actions, onAdd, inDay, onOpen }: {
  title: string; tone?: "danger" | "warning"; steps: MyStep[]; today: string; actions: (s: MyStep) => ReactNode;
  onAdd: (s: MyStep) => void; inDay: Set<string | null>; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="mw-mini">
      <h4 className={cx("mw-mini__title", tone && `is-${tone}`)}>{title} · {steps.length}</h4>
      {steps.map((s) => {
        const dl = deadline(s, today);
        return (
          <div key={s.id} className="mw-mini__item">
            <button type="button" className="mw-mini__name" onClick={() => onOpen(s)}>
              <strong>{s.name}</strong>
              <span className="subtext">{s.project_code ?? s.project_name} · {s.service_name}</span>
            </button>
            <span className={cx("mw-dl", `is-${dl.tone}`)}>{dl.text}</span>
            <div className="mw-mini__actions">
              {actions(s)}
              {!inDay.has(s.id) && <Button size="sm" variant="ghost" icon="plus" onClick={() => onAdd(s)}>Adicionar ao meu dia</Button>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/* ==========================================================================
   Minhas etapas
   ========================================================================== */
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "overdue", label: "Atrasadas" },
  { key: "in_progress", label: "Em andamento" },
  { key: "waiting", label: "Aguardando" },
  { key: "upcoming", label: "Próximas" },
  { key: "done", label: "Concluídas (últimos 60 dias)" },
];

function StepsView({ steps, today, stepActions, onOpen }: {
  steps: MyStep[]; today: string; stepActions: (s: MyStep) => ReactNode; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  const [scope, setScope] = useState<"open" | "done" | "all">("open");
  const [project, setProject] = useState("");
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    steps.forEach((s) => m.set(s.project_id, `${s.project_code ? `${s.project_code} · ` : ""}${s.project_name}`));
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [steps]);
  const list = steps.filter((s) => (!project || s.project_id === project) && (scope === "all" || (scope === "done" ? isDone(s) : !isDone(s))));

  // Evolução por projeto: minhas etapas concluídas / total
  const perProject = useMemo(() => projects.map((p) => {
    const mine = steps.filter((s) => s.project_id === p.value);
    return { ...p, done: mine.filter(isDone).length, total: mine.length };
  }), [projects, steps]);

  return (
    <div className="stack">
      <div className="mw-filters">
        <Segmented<"open" | "done" | "all"> label="Etapas" value={scope} onChange={setScope}
          options={[{ value: "open", label: "Abertas" }, { value: "done", label: "Concluídas" }, { value: "all", label: "Todas" }]} />
        <div className="mw-filters__project">
          <OptionPicker label="Projeto" value={project} clearable placeholder="Todos os projetos" options={projects} onChange={setProject} />
        </div>
      </div>
      {!project && perProject.length > 1 && (
        <div className="mw-projects">
          {perProject.map((p) => (
            <button key={p.value} type="button" className="mw-proj" onClick={() => setProject(p.value)}>
              <span className="mw-proj__name">{p.label}</span>
              <ProgressBar value={p.total ? (p.done / p.total) * 100 : 0} label={`Minhas etapas concluídas em ${p.label}`} thin />
              <span className="subtext">{p.done} de {plural(p.total, "etapa minha", "etapas minhas")} concluídas</span>
            </button>
          ))}
        </div>
      )}
      {list.length === 0 ? (
        <Card><EmptyState icon="checkCircle" title={scope === "done" ? "Nenhuma etapa concluída nos últimos 60 dias." : "Nenhuma etapa aberta sob sua responsabilidade."}
          text="Quando o líder colocar você como responsável por uma etapa, ela aparece aqui." /></Card>
      ) : BUCKETS.map((b) => {
        const rows = list.filter((s) => bucketOf(s, today) === b.key);
        if (rows.length === 0) return null;
        return (
          <section key={b.key} className="mw-bucket">
            <h3 className={cx("mw-bucket__title", `is-${b.key}`)}>{b.label} <span className="muted">· {rows.length}</span></h3>
            <div className="mw-cards">
              {rows.map((s) => <StepCard key={s.id} step={s} today={today} actions={stepActions(s)} onOpen={() => onOpen(s)} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function StepCard({ step: s, today, actions, onOpen }: { step: MyStep; today: string; actions: ReactNode; onOpen: () => void }) {
  const dl = deadline(s, today);
  const prog = timeProgress(s, today);
  return (
    <article className={cx("mw-card", `is-${bucketOf(s, today)}`)}>
      <button type="button" className="mw-card__proj" onClick={onOpen}>{s.project_code ? `${s.project_code} · ` : ""}{s.project_name}</button>
      <div className="mw-card__head">
        <h4 className="mw-card__name">{s.name}</h4>
        <StatusBadge status={shownStatus(s, today)} />
      </div>
      <p className="subtext mw-card__svc">{s.service_name}{s.client_name ? ` · ${s.client_name}` : ""}
        {s.reopen_count > 0 && <> · <Badge tone="warning" tag>Reaberta</Badge></>}</p>
      <dl className="mw-card__dates">
        <div><dt>Início</dt><dd>{formatDate(stepStart(s))}</dd></div>
        <div><dt>Entrega</dt><dd>{s.planned_end_date ? formatDate(s.planned_end_date) : "A definir"}</dd></div>
        {s.planned_duration_days ? <div><dt>Duração</dt><dd>{s.planned_duration_days} d.u.</dd></div> : null}
      </dl>
      <div className="mw-card__prog">
        <ProgressBar value={prog} label={`Prazo consumido de ${s.name}`} thin tone={isOverdue(s, today) ? "danger" : undefined} />
        <span className={cx("mw-dl", `is-${dl.tone}`)}>{dl.text}</span>
      </div>
      {s.waiting_reason && WAITING.includes(s.status) && <p className="mw-card__wait"><Icon name="pause" size={14} /> {s.waiting_reason}</p>}
      {actions}
    </article>
  );
}

/* ==========================================================================
   Agenda (mês e lista)
   ========================================================================== */
function AgendaView({ steps, items, today, actions, onOpen }: {
  steps: MyStep[]; items: WorkItem[]; today: string; actions: ItemActions; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  const mobile = useIsMobile();
  const [mode, setMode] = useState<"month" | "list">(mobile ? "list" : "month");
  const [month, setMonth] = useState(() => today.slice(0, 8) + "01");
  const [day, setDay] = useState(today);
  const dated = steps.filter((s) => stepStart(s) && stepEnd(s));

  return (
    <div className="stack">
      <div className="mw-cal-bar">
        {mode === "month" && (
          <div className="row">
            <Button size="sm" variant="ghost" iconOnly icon="chevronRight" className="flip" onClick={() => setMonth(shiftMonth(month, -1))}>Mês anterior</Button>
            <h3 className="mw-cal-title">{cap(MONTH_FMT.format(parse(month)))}</h3>
            <Button size="sm" variant="ghost" iconOnly icon="chevronRight" onClick={() => setMonth(shiftMonth(month, 1))}>Próximo mês</Button>
            <Button size="sm" variant="secondary" onClick={() => { setMonth(today.slice(0, 8) + "01"); setDay(today); }}>Hoje</Button>
          </div>
        )}
        <Segmented<"month" | "list"> label="Visualização da agenda" value={mode} onChange={setMode}
          options={[{ value: "month", label: "Mês" }, { value: "list", label: "Lista" }]} />
      </div>
      <div className="mw-legend" aria-hidden="true">
        <span><i className="is-in_progress" /> Em andamento</span><span><i className="is-upcoming" /> Próxima</span>
        <span><i className="is-waiting" /> Aguardando</span><span><i className="is-overdue" /> Atrasada</span><span><i className="is-done" /> Concluída</span>
        <span><i className="is-todo" /> Tarefa do dia</span>
      </div>
      {mode === "month" ? (
        <div className="mw-cal-wrap">
          <MonthGrid month={month} steps={dated} items={items} today={today} selected={day} onSelect={setDay} onOpen={onOpen} />
          <DayPanel day={day} steps={dated} allSteps={steps} items={items} today={today} actions={actions} onOpen={onOpen} />
        </div>
      ) : (
        <AgendaList steps={dated} items={items} today={today} actions={actions} onOpen={onOpen} />
      )}
    </div>
  );
}

const shiftMonth = (m: string, n: number) => { const d = parse(m); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 8) + "01"; };

function MonthGrid({ month, steps, items, today, selected, onSelect, onOpen }: {
  month: string; steps: MyStep[]; items: WorkItem[]; today: string; selected: string;
  onSelect: (d: string) => void; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  const first = parse(month);
  const offset = (first.getDay() + 6) % 7; // segunda = 0
  const gridStart = addDays(month, -offset);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const weeks = Math.ceil((offset + last.getDate()) / 7);
  const MAX_LANES = 3;

  return (
    <div className="mw-cal" role="grid" aria-label={`Agenda de ${MONTH_FMT.format(first)}`}>
      <div className="mw-cal__head" role="row">{WEEKDAYS.map((w) => <span key={w} role="columnheader">{w}</span>)}</div>
      {Array.from({ length: weeks }, (_, w) => {
        const ws = addDays(gridStart, w * 7); const we = addDays(ws, 6);
        const segs = steps
          .filter((s) => stepStart(s)! <= we && stepEnd(s)! >= ws)
          .map((s) => ({ s, c0: Math.max(0, diffDays(ws, stepStart(s)!)), c1: Math.min(6, diffDays(ws, stepEnd(s)!)),
                         cutL: stepStart(s)! < ws, cutR: stepEnd(s)! > we }))
          .sort((a, b) => a.c0 - b.c0 || (b.c1 - b.c0) - (a.c1 - a.c0));
        const lanes: number[][] = [];
        const placed = segs.map((g) => {
          let lane = lanes.findIndex((l) => l.every((c) => c < g.c0 || c > g.c1));
          if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }
          for (let c = g.c0; c <= g.c1; c++) lanes[lane].push(c);
          return { ...g, lane };
        });
        const hidden = Array.from({ length: 7 }, (_, c) => placed.filter((g) => g.lane >= MAX_LANES && g.c0 <= c && g.c1 >= c).length);
        return (
          <div key={w} className="mw-week" role="row" style={{ ["--lanes" as string]: Math.min(lanes.length, MAX_LANES) }}>
            {Array.from({ length: 7 }, (_, c) => {
              const d = addDays(ws, c);
              const todos = items.filter((i) => i.due_date === d);
              const open = todos.filter((i) => !i.done_at).length;
              return (
                <button key={d} type="button" role="gridcell" aria-selected={d === selected}
                  className={cx("mw-day", d.slice(0, 7) !== month.slice(0, 7) && "is-out", d === today && "is-today", d === selected && "is-sel", c >= 5 && "is-weekend")}
                  style={{ gridColumn: c + 1 }} onClick={() => onSelect(d)}
                  aria-label={`${DAY_FMT.format(parse(d))}${todos.length ? `, ${plural(todos.length, "tarefa", "tarefas")}` : ""}`}>
                  <span className="mw-day__n">{parse(d).getDate()}</span>
                  {todos.length > 0 && <span className={cx("mw-day__todo", open === 0 && "is-done")}>{open > 0 ? open : <Icon name="check" size={10} />}</span>}
                  {hidden[c] > 0 && <span className="mw-day__more">+{hidden[c]}</span>}
                </button>
              );
            })}
            {placed.filter((g) => g.lane < MAX_LANES).map((g) => (
              <button key={g.s.id} type="button" className={cx("mw-bar", `is-${bucketOf(g.s, today)}`, g.cutL && "cut-l", g.cutR && "cut-r")}
                style={{ gridColumn: `${g.c0 + 1} / ${g.c1 + 2}`, gridRow: g.lane + 2 }}
                title={`${g.s.name} · ${g.s.project_code ?? g.s.project_name} · ${formatDate(stepStart(g.s))} a ${formatDate(stepEnd(g.s))}`}
                onClick={() => onOpen(g.s)}>
                {g.s.name} <span className="mw-bar__proj">· {g.s.project_code ?? g.s.project_name}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function DayPanel({ day, steps, allSteps, items, today, actions, onOpen }: {
  day: string; steps: MyStep[]; allSteps: MyStep[]; items: WorkItem[]; today: string; actions: ItemActions; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  const active = steps.filter((s) => stepStart(s)! <= day && stepEnd(s)! >= day);
  const ending = active.filter((s) => s.planned_end_date === day && !isDone(s));
  const todos = items.filter((i) => i.due_date === day);
  const byId = new Map(allSteps.map((s) => [s.id, s]));
  return (
    <Card className="mw-daypanel" title={cap(DAY_FMT.format(parse(day)))}>
      {day >= today && <QuickAdd steps={allSteps.filter((s) => !isDone(s))} today={today} onAdd={actions.add} date={day} />}
      <ItemGroup title="Tarefas" count={todos.length}>
        {todos.length === 0 ? <p className="subtext mw-empty">Nenhuma tarefa neste dia.</p> :
          todos.map((i) => <ItemRow key={i.id} item={i} step={byId.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen}
            late={!i.done_at && i.due_date < today} />)}
      </ItemGroup>
      <ItemGroup title="Etapas neste dia" count={active.length}>
        {active.length === 0 ? <p className="subtext mw-empty">Nenhuma etapa sua neste dia.</p> : active.map((s) => (
          <li key={s.id} className="mw-item">
            <span className={cx("mw-dot", `is-${bucketOf(s, today)}`)} aria-hidden="true" />
            <button type="button" className="mw-item__main mw-link-block" onClick={() => onOpen(s)}>
              <span className="mw-item__title">{s.name}</span>
              <span className="mw-item__meta">{s.project_code ?? s.project_name} · {s.service_name}
                {ending.includes(s) && <strong className="mw-late"> · entrega neste dia</strong>}</span>
            </button>
          </li>
        ))}
      </ItemGroup>
    </Card>
  );
}

function AgendaList({ steps, items, today, actions, onOpen }: {
  steps: MyStep[]; items: WorkItem[]; today: string; actions: ItemActions; onOpen: (s: { id: string; project_id: string }) => void;
}) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const until = addDays(today, 45);
  const lateSteps = steps.filter((s) => isOverdue(s, today));
  const lateItems = items.filter((i) => !i.done_at && i.due_date < today);
  const days: string[] = [];
  for (let d = today; d <= until; d = addDays(d, 1)) days.push(d);
  return (
    <div className="mw-agenda">
      {(lateSteps.length > 0 || lateItems.length > 0) && (
        <section className="mw-aday is-late">
          <h3 className="mw-aday__title">Em atraso</h3>
          <ul className="mw-items">
            {lateSteps.map((s) => <AgendaStep key={s.id} s={s} today={today} label={`entrega era ${formatDate(s.planned_end_date)}`} onOpen={onOpen} />)}
            {lateItems.map((i) => <ItemRow key={i.id} item={i} step={byId.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen} late />)}
          </ul>
        </section>
      )}
      {days.map((d) => {
        const ends = steps.filter((s) => !isDone(s) && s.planned_end_date === d);
        const starts = steps.filter((s) => !isDone(s) && !s.actual_start_date && s.planned_start_date === d);
        const todos = items.filter((i) => i.due_date === d);
        if (ends.length + starts.length + todos.length === 0) return null;
        return (
          <section key={d} className={cx("mw-aday", d === today && "is-today")}>
            <h3 className="mw-aday__title">{d === today ? `Hoje · ${DAY_FMT.format(parse(d))}` : cap(DAY_FMT.format(parse(d)))}</h3>
            <ul className="mw-items">
              {ends.map((s) => <AgendaStep key={`e${s.id}`} s={s} today={today} label="entrega" onOpen={onOpen} />)}
              {starts.map((s) => <AgendaStep key={`s${s.id}`} s={s} today={today} label="começa" onOpen={onOpen} />)}
              {todos.map((i) => <ItemRow key={i.id} item={i} step={byId.get(i.project_task_id ?? "")} today={today} actions={actions} onOpen={onOpen} />)}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AgendaStep({ s, today, label, onOpen }: { s: MyStep; today: string; label: string; onOpen: (s: { id: string; project_id: string }) => void }) {
  return (
    <li className="mw-item">
      <span className={cx("mw-dot", `is-${bucketOf(s, today)}`)} aria-hidden="true" />
      <button type="button" className="mw-item__main mw-link-block" onClick={() => onOpen(s)}>
        <span className="mw-item__title">{s.name} <span className={cx("mw-tag", label === "entrega" && "is-due")}>{label}</span></span>
        <span className="mw-item__meta">{s.project_code ?? s.project_name} · {s.service_name}</span>
      </button>
      <StatusBadge status={shownStatus(s, today)} />
    </li>
  );
}
