import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync } from "@/hooks";
import { useSearchParam } from "@/lib/router";
import {
  Avatar, Button, Card, EmptyState, Field, Input, LoadError, MetricCard, ProgressBar, Segmented, Skeleton,
} from "@/components/ui/primitives";
import { ConfirmDialog, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { OptionPicker } from "@/components/ui/OptionPicker";
import type { TeamPerson, WorkItem } from "@/types/domain";
import { cx, formatDate, plural } from "@/utils/format";
import { addDays, diffDays, doneDay, teamStats } from "@/pages/work/workStats";

/* ==========================================================================
   Tarefas da equipe — a liderança agenda tarefas e acompanha a execução
   ========================================================================== */
type Tone = "danger" | "warning" | "neutral" | "success";
export function workState(w: WorkItem, today: string): { text: string; tone: Tone; key: "late" | "today" | "upcoming" | "done" | "done_late" } {
  const dd = doneDay(w);
  if (dd) {
    const late = diffDays(w.due_date, dd);
    return late > 0
      ? { text: `Feita com ${plural(late, "dia", "dias")} de atraso`, tone: "warning", key: "done_late" }
      : { text: `Feita em ${formatDate(dd)}`, tone: "success", key: "done" };
  }
  const d = diffDays(today, w.due_date);
  if (d < 0) return { text: `Atrasada há ${plural(-d, "dia", "dias")}`, tone: "danger", key: "late" };
  if (d === 0) return { text: "Para hoje", tone: "warning", key: "today" };
  if (d === 1) return { text: "Amanhã", tone: "neutral", key: "upcoming" };
  return { text: `Em ${d} dias`, tone: "neutral", key: "upcoming" };
}

type StatusFilter = "open" | "late" | "done" | "all";

export function TeamWorkView({ today, onOpen, newDate, onNewDone, onChanged }: {
  today: string; onOpen: (s: { id: string; project_id: string }) => void; newDate?: string | null; onNewDone?: () => void; onChanged?: () => void;
}) {
  const toast = useToast();
  const { profile } = useAuth();
  const q = useAsync(() => api.teamWorkItems(), []);
  const peopleQ = useAsync(() => api.assignablePeople(), []);
  const [items, setItems] = useState<WorkItem[]>([]);
  useEffect(() => { if (q.data) setItems(q.data); }, [q.data]);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [person, setPerson] = useState("");
  const [mine, setMine] = useState<"all" | "mine">("all");
  const [editing, setEditing] = useState<WorkItem | "new" | null>(useSearchParam("nova") ? "new" : null);
  const [removing, setRemoving] = useState<WorkItem | null>(null);
  useEffect(() => { if (newDate) setEditing("new"); }, [newDate]);
  const closeModal = () => { setEditing(null); onNewDone?.(); };
  const [busy, setBusy] = useState(false);

  const scoped = items.filter((w) => mine === "all" || w.assigned_by?.id === profile?.id);
  const ofPerson = scoped.filter((w) => !person || w.owner?.id === person);
  const stats = useMemo(() => teamStats(ofPerson, today), [ofPerson, today]);
  const perPerson = useMemo(() => teamStats(scoped, today).people, [scoped, today]);

  const order = { late: 0, today: 1, upcoming: 2, done_late: 3, done: 3 } as const;
  const list = ofPerson
    .filter((w) => status === "all" || (status === "done" ? !!w.done_at : status === "late" ? !w.done_at && w.due_date < today : !w.done_at))
    .map((w) => ({ w, st: workState(w, today) }))
    .sort((a, b) => order[a.st.key] - order[b.st.key]
      || (a.w.done_at && b.w.done_at ? b.w.done_at.localeCompare(a.w.done_at) : a.w.due_date.localeCompare(b.w.due_date)));

  const personOptions = useMemo(() => {
    const m = new Map<string, string>();
    (peopleQ.data ?? []).forEach((p) => m.set(p.id, p.name));
    items.forEach((w) => w.owner && m.set(w.owner.id, w.owner.name));
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [peopleQ.data, items]);

  async function remove(w: WorkItem) {
    setBusy(true);
    try { await api.deleteWorkItem(w.id); setItems((xs) => xs.filter((x) => x.id !== w.id)); toast("Tarefa excluída."); setRemoving(null); onChanged?.(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (q.loading && !q.data) return <><Skeleton height={100} radius={16} /><Skeleton height={260} radius={16} /></>;

  return (
    <div className="stack">
      <div className="tw-head">
        <p className="subtext tw-head__text">Tarefas fora do cronograma que você agenda para a equipe. Elas entram no “Hoje” de cada pessoa, que marca quando fizer.</p>
        <Button icon="plus" onClick={() => setEditing("new")}>Nova tarefa</Button>
      </div>

      <div className="metrics">
        <MetricCard label="Em aberto" value={stats.open} onClick={() => setStatus("open")} />
        <MetricCard label="Para hoje" value={stats.today} tone={stats.today ? "brand" : "quiet"} onClick={() => setStatus("open")} />
        <MetricCard label="Em atraso" value={stats.late} tone={stats.late ? "danger" : "quiet"} onClick={() => setStatus("late")} />
        <MetricCard label="Concluídas (30 dias)" value={stats.done30} onClick={() => setStatus("done")} />
        <MetricCard label="No prazo" value={stats.onTimePct == null ? "—" : `${stats.onTimePct}%`} hint="Das concluídas em 30 dias" tone="quiet" />
      </div>

      {perPerson.length > 0 && (
        <section className="tw-people" aria-label="Por pessoa">
          {perPerson.map((r) => (
            <button key={r.p.id} type="button" className={cx("tw-person", person === r.p.id && "is-sel")} aria-pressed={person === r.p.id}
              onClick={() => setPerson(person === r.p.id ? "" : r.p.id)}>
              <span className="tw-person__head">
                <Avatar name={r.p.name} src={r.p.avatar_url} size="sm" />
                <strong>{r.p.name}</strong>
              </span>
              <ProgressBar value={r.total ? (r.done / r.total) * 100 : 0} label={`Tarefas concluídas por ${r.p.name}`} thin tone={r.late ? "danger" : undefined} />
              <span className="tw-person__stats">
                <span><b>{r.open}</b> em aberto</span>
                <span className={cx(r.late > 0 && "is-danger")}><b>{r.late}</b> {r.late === 1 ? "atrasada" : "atrasadas"}</span>
                <span className="is-success"><b>{r.done}</b> {r.done === 1 ? "feita" : "feitas"}</span>
              </span>
            </button>
          ))}
        </section>
      )}

      <div className="mw-filters">
        <Segmented<StatusFilter> label="Situação" value={status} onChange={setStatus}
          options={[{ value: "open", label: "Em aberto" }, { value: "late", label: "Atrasadas" }, { value: "done", label: "Concluídas" }, { value: "all", label: "Todas" }]} />
        <div className="mw-filters__project">
          <OptionPicker label="Pessoa" value={person} clearable placeholder="Toda a equipe" options={personOptions} onChange={setPerson} />
        </div>
        <Segmented<"all" | "mine"> label="Quem atribuiu" value={mine} onChange={setMine}
          options={[{ value: "all", label: "Toda a liderança" }, { value: "mine", label: "Criadas por mim" }]} />
      </div>

      <Card flush>
        {list.length === 0 ? (
          <EmptyState icon="checkCircle"
            title={items.length === 0 ? "Nenhuma tarefa atribuída ainda." : status === "late" ? "Nenhuma tarefa em atraso." : "Nenhuma tarefa com estes filtros."}
            text={items.length === 0 ? "Use “Nova tarefa” para agendar uma atividade e escolher quem é responsável." : undefined}
            action={items.length === 0 ? <Button icon="plus" onClick={() => setEditing("new")}>Nova tarefa</Button> : undefined} />
        ) : (
          <ul className="tw-list">
            {list.map(({ w, st }) => (
              <li key={w.id} className={cx("tw-row", `is-${st.key}`)}>
                <span className={cx("tw-state", w.done_at && "is-on")} aria-hidden="true">{w.done_at && <Icon name="check" size={12} />}</span>
                <div className="tw-row__main">
                  <span className="tw-row__title">{w.title}</span>
                  {w.description && <span className="tw-row__desc">{w.description}</span>}
                  <span className="tw-row__meta">
                    {w.project_id && (w.project_code || w.project_name) && (
                      <button type="button" className="mw-link" onClick={() => onOpen({ id: w.project_task_id ?? "", project_id: w.project_id! })}>
                        {[w.project_code ?? w.project_name, w.step_name].filter(Boolean).join(" · ")}
                      </button>
                    )}
                    {w.assigned_by && <span>por {w.assigned_by.id === profile?.id ? "você" : w.assigned_by.name}</span>}
                  </span>
                </div>
                <span className="tw-row__who">
                  {w.owner && <><Avatar name={w.owner.name} src={w.owner.avatar_url} size="sm" /><span>{w.owner.name}</span></>}
                </span>
                <span className="tw-row__when">
                  <span className="tw-row__date">{formatDate(w.due_date)}</span>
                  <span className={cx("mw-dl", `is-${st.tone}`)}>{st.text}</span>
                </span>
                <span className="tw-row__actions">
                  {!w.done_at && <Button size="sm" variant="ghost" icon="edit" iconOnly onClick={() => setEditing(w)}>Editar</Button>}
                  <Button size="sm" variant="ghost" icon="x" iconOnly onClick={() => setRemoving(w)}>Excluir</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AssignWorkModal open={!!editing} item={editing === "new" ? null : editing} people={peopleQ.data ?? []} today={today}
        defaultDate={newDate ?? null}
        onClose={closeModal}
        onSaved={(msg) => { closeModal(); toast(msg); void q.reload(); onChanged?.(); }} />
      <ConfirmDialog open={!!removing} danger title={`Excluir “${removing?.title ?? ""}”?`}
        message={`A tarefa sai da lista de ${removing?.owner?.name ?? "quem é responsável"}.`} confirmLabel="Excluir tarefa" loading={busy}
        onCancel={() => setRemoving(null)} onConfirm={() => removing && remove(removing)} />
    </div>
  );
}

/* ==========================================================================
   Nova tarefa / editar
   ========================================================================== */
function AssignWorkModal({ open, item, people, today, defaultDate, onClose, onSaved }: {
  open: boolean; item: WorkItem | null; people: TeamPerson[]; today: string; defaultDate?: string | null; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const toast = useToast();
  const { profile } = useAuth();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [owners, setOwners] = useState<string[]>([]);
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState(today);
  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? ""); setDescription(item?.description ?? "");
    setOwners([]); setOwner(item?.owner?.id ?? ""); setDue(item?.due_date ?? defaultDate ?? today);
    setProject(item?.project_id ?? ""); setTask(item?.project_task_id ?? ""); setTried(false);
  }, [open, item, today, defaultDate]);

  const projectsQ = useAsync(() => (open ? api.listProjects() : Promise.resolve(null)), [open]);
  const scheduleQ = useAsync(() => (open && project ? api.getProjectSchedule(project) : Promise.resolve(null)), [open, project]);

  const projectOptions = (projectsQ.data ?? [])
    .filter((p) => p.status !== "cancelled" && (p.status !== "completed" || p.id === project))
    .map((p) => ({ value: p.id, label: p.code ? `${p.code} · ${p.name}` : p.name, keywords: p.code ?? undefined }));
  const stepOptions = useMemo(() => {
    const s = scheduleQ.data; if (!s) return [];
    const svc = new Map(s.tracks.map((t) => [t.id, t.project_service?.service?.name ?? "Serviço"]));
    return s.tasks.filter((t) => !["completed", "cancelled"].includes(t.status) || t.id === task)
      .map((t) => ({ value: t.id, label: t.name, group: svc.get(t.schedule_track_id) ?? "Serviço" }));
  }, [scheduleQ.data, task]);
  const peopleOptions = people.map((p) => ({ value: p.id, label: p.name, hint: p.role === "leader" ? "Líder" : p.role === "unit_admin" ? "Admin da unidade" : p.employment_type === "pj" ? "PJ" : "CLT" }));
  if (item?.owner && !people.some((p) => p.id === item.owner!.id)) peopleOptions.unshift({ value: item.owner.id, label: item.owner.name, hint: "" });
  if (!item && profile) peopleOptions.unshift({ value: profile.id, label: `${profile.name} (eu)`, hint: "Fica nas suas tarefas" });

  const who = item ? (owner ? [owner] : []) : owners;
  const errors = { title: !title.trim() ? "Descreva a tarefa." : null, who: who.length === 0 ? "Escolha quem vai fazer." : null, due: !due ? "Informe a data." : null };
  const valid = !errors.title && !errors.who && !errors.due;

  async function save() {
    setTried(true);
    if (!valid) return;
    setSaving(true);
    try {
      if (item) {
        await api.updateWorkItem(item.id, { title: title.trim(), description: description.trim() || null, due_date: due, owner_id: owner,
          project_task_id: task || null, project_id: task ? undefined : project || null });
        onSaved("Tarefa atualizada.");
      } else {
        const n = await api.assignWorkItems({ owners, title, due_date: due, description, task_id: task || null, project_id: project || null });
        onSaved(n > 1 ? `${n} tarefas criadas, uma para cada pessoa.` : "Tarefa criada e enviada.");
      }
    } catch (e) { toast((e as Error).message, "error"); } finally { setSaving(false); }
  }

  const quick = [{ label: "Hoje", d: today }, { label: "Amanhã", d: addDays(today, 1) }, { label: "Em 7 dias", d: addDays(today, 7) }];

  return (
    <Modal open={open} onClose={onClose} wide title={item ? "Editar tarefa" : "Nova tarefa para a equipe"}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={saving} onClick={save}>{item ? "Salvar" : who.length > 1 ? `Criar para ${who.length} pessoas` : "Criar tarefa"}</Button>
      </>}>
      <div className="stack tw-form">
        <Field label="Tarefa" required error={tried ? errors.title : null}>
          {({ id, invalid }) => <Input id={id} autoFocus value={title} maxLength={300} aria-invalid={invalid} placeholder="Ex.: Atualizar memorial descritivo"
            onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Detalhes" hint="Opcional. O que precisa ser entregue, onde encontrar os arquivos.">
          {({ id }) => <textarea id={id} className="input textarea" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={item ? "Responsável" : "Responsáveis"} required error={tried ? errors.who : null}
          hint={item ? undefined : "Escolha uma ou mais pessoas, incluindo você: cada uma recebe a sua tarefa."}>
          {() => item
            ? <OptionPicker label="Responsável" value={owner} options={peopleOptions} onChange={setOwner} invalid={tried && !!errors.who} placeholder="Escolha a pessoa" />
            : <OptionPicker label="Responsáveis" multiple value={owners} options={peopleOptions} onChange={setOwners} invalid={tried && !!errors.who}
                placeholder="Escolha quem vai fazer" loading={people.length === 0} />}
        </Field>
        <Field label="Data de entrega" required error={tried ? errors.due : null}>
          {({ id, invalid }) => (
            <div className="tw-date">
              <Input id={id} type="date" value={due} aria-invalid={invalid} onChange={(e) => setDue(e.target.value)} />
              {quick.map((x) => (
                <Button key={x.label} size="sm" variant={due === x.d ? "secondary" : "ghost"} onClick={() => setDue(x.d)}>{x.label}</Button>
              ))}
            </div>
          )}
        </Field>
        <div className="tw-link">
          <Field label="Projeto" hint="Opcional.">
            {() => <OptionPicker label="Projeto" value={project} clearable options={projectOptions} loading={projectsQ.loading}
              placeholder="Sem projeto" searchPlaceholder="Buscar por código ou nome" onChange={(v) => { setProject(v); setTask(""); }} />}
          </Field>
          <Field label="Etapa" hint={project ? "Opcional." : "Escolha o projeto antes."}>
            {() => <OptionPicker label="Etapa" value={task} clearable options={stepOptions} disabled={!project} loading={!!project && scheduleQ.loading}
              placeholder="Sem etapa" searchPlaceholder="Buscar etapa" onChange={setTask} />}
          </Field>
        </div>
      </div>
    </Modal>
  );
}
