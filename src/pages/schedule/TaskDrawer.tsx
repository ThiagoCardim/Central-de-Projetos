import { useAuth } from "@/services/auth";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Alert, Avatar, Badge, Button, Field, Input, Select, Skeleton, StatusBadge } from "@/components/ui/primitives";
import { Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { ProjectSchedule, ScheduleTask, SchedulePreview, StaffMember, TaskChange, TaskStatus } from "@/types/domain";
import { cx, EMPLOYMENT_LABEL, formatDate, formatDateTime, plural, TASK_STATUS_LABEL } from "@/utils/format";
import { ImpactPreview } from "./ImpactPreview";
import { canRequestAdjustment } from "./Adjustments";
import { EMPTY_REASON, ReasonField, reasonIsValid, reasonText, useChangeReasons } from "./ReasonField";
import type { ReasonKind } from "@/types/domain";

const STATUS_REASON_KIND: Partial<Record<TaskStatus, ReasonKind>> = {
  waiting_client: "waiting_client", waiting_third_party: "waiting_third_party", waiting_dependency: "waiting_dependency", cancelled: "task_cancel",
};
import {
  CHANGE_LABEL, displayStatus, durationText, isClosed, isStarted, predecessorsOf, serviceName,
  statusActions, successorsOf, type StatusAction,
} from "./model";

interface Props {
  task: ScheduleTask | null;
  schedule: ProjectSchedule;
  staff: StaffMember[];
  me: string | null;
  canManage: boolean;      // gestor do projeto
  managementMode: boolean; // modo gestão ligado
  onClose: () => void;
  onChanged: () => void;
  onOpenTask: (id: string) => void;
  /** Abre o pedido de ajuste entre setores para esta etapa. */
  onRequestAdjustment?: (taskId: string) => void;
}

export function TaskDrawer({ task, schedule, staff, me, canManage, managementMode, onClose, onChanged, onOpenTask, onRequestAdjustment }: Props) {
  if (!task) return null;
  return (
    <Drawer open onClose={onClose} title={task.name}
      subtitle={<>{serviceName(schedule.tracks.find((t) => t.id === task.schedule_track_id))}</>}>
      <TaskBody key={task.id} task={task} schedule={schedule} staff={staff} me={me} canManage={canManage}
        managementMode={managementMode} onChanged={onChanged} onOpenTask={onOpenTask} onRequestAdjustment={onRequestAdjustment} />
    </Drawer>
  );
}

function TaskBody({ task, schedule, staff, me, canManage, managementMode, onChanged, onOpenTask, onRequestAdjustment }: Omit<Props, "onClose" | "task"> & { task: ScheduleTask }) {
  const toast = useToast();
  const [notesVersion, setNotesVersion] = useState(0);
  const { permissions } = useAuth();
  const isStaff = !!permissions && permissions.role !== "client";
  const isResponsible = !!me && task.responsible_user_id === me;
  const canAct = canManage || isResponsible;
  const manage = canManage && managementMode;
  const person = (id: string | null) => staff.find((s) => s.id === id);
  const shown = displayStatus(task);

  return (
    <div className="stack tdrawer">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <StatusBadge status={shown} />
        {shown === "overdue" && task.status !== "overdue" && <Badge>{TASK_STATUS_LABEL[task.status]}</Badge>}
        {!task.client_visible && <Badge tag outline title="O cliente não vê esta etapa">Interna</Badge>}
        {(task.reopen_count ?? 0) > 0 && (
          <Badge tone="warning" tag title={task.last_reopened_at ? `Última reabertura: ${formatDate(task.last_reopened_at, true)}` : undefined}>
            {task.reopen_count === 1 ? "Reaberta" : `Reaberta ${task.reopen_count}x`}
          </Badge>
        )}
      </div>

      {task.auto_skipped && (
        <Alert tone="info" title="Etapa dispensada">O serviço do qual ela depende não foi contratado. Se for contratado depois, a etapa volta automaticamente.</Alert>
      )}
      {task.waiting_reason && !task.auto_skipped && (
        <Alert tone="warning" title={task.status === "cancelled" ? "Motivo do cancelamento" : "Motivo da espera"}>
          {task.waiting_reason}
          <span className="tdrawer__private"> · visível só para a equipe</span>
        </Alert>
      )}

      <dl className="kv">
        <div><dt>Responsável</dt><dd>
          {manage ? <ResponsibleSelect task={task} staff={staff} onChanged={onChanged} /> :
            task.responsible_user_id ? <span className="row"><Avatar name={person(task.responsible_user_id)?.name ?? "?"} size="sm" />{person(task.responsible_user_id)?.name ?? "Pessoa da equipe"}</span>
              : <span className="text-warning">Sem responsável</span>}
        </dd></div>
        <div><dt>Duração</dt><dd>{durationText(task)}</dd></div>
        <div><dt>Início previsto</dt><dd className="num">{task.planned_start_date ? formatDate(task.planned_start_date, true) : "A definir"}</dd></div>
        <div><dt>Término previsto</dt><dd className="num">{task.planned_end_date ? formatDate(task.planned_end_date, true) : task.duration_type === "ongoing" ? "Contínua" : "A definir"}</dd></div>
        {task.actual_start_date && <div><dt>Início real</dt><dd className="num">{formatDate(task.actual_start_date, true)}</dd></div>}
        {task.actual_end_date && <div><dt>Término real</dt><dd className="num">{formatDate(task.actual_end_date, true)}</dd></div>}
        {task.start_not_before && <div><dt>Não iniciar antes de</dt><dd className="num">{formatDate(task.start_not_before, true)}</dd></div>}
      </dl>
      {!task.planned_end_date && task.duration_type === "fixed" && !isClosed(task) && (
        <p className="subtext">Prazo ainda não definido pela YouCon para esta etapa{canManage ? ". Defina a duração em “Ajustar prazo” para calcular as datas seguintes." : "."}</p>
      )}

      {canAct && <StatusActions task={task} manager={canManage} onChanged={onChanged} toast={toast} />}

      {manage && !isClosed(task) && <ReschedulePanel task={task} onChanged={onChanged} toast={toast} />}
      {canManage && task.status === "completed" && (task.duration_type === "fixed" || task.duration_type === "external") &&
        <ReopenPanel task={task} onChanged={onChanged} toast={toast} />}
      {onRequestAdjustment && canRequestAdjustment(task) && (
        <section className="tdrawer__section">
          <Button variant="outline" size="sm" icon="refresh" onClick={() => onRequestAdjustment(task.id)}>Solicitar ajuste nesta etapa</Button>
          <p className="subtext" style={{ marginTop: 6 }}>Para pedir a este setor que revise algo; o líder da área aprova e define o prazo.</p>
        </section>
      )}

      <Dependencies task={task} schedule={schedule} manage={manage} onChanged={onChanged} onOpenTask={onOpenTask} toast={toast} />

      {isStaff && <Notes task={task} version={notesVersion} onAdded={() => setNotesVersion((v) => v + 1)} toast={toast} />}

      <History task={task} schedule={schedule} staff={staff} version={notesVersion} />
    </div>
  );
}

type Toast = ReturnType<typeof useToast>;

function ResponsibleSelect({ task, staff, onChanged }: { task: ScheduleTask; staff: StaffMember[]; onChanged: () => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  return (
    <Select aria-label="Responsável pela etapa" value={task.responsible_user_id ?? ""} disabled={saving}
      onChange={async (e) => {
        setSaving(true);
        try {
          await api.setTaskResponsible(task.id, e.target.value || null);
          toast(e.target.value ? "Responsável definido. A pessoa recebe um aviso." : "Responsável removido.");
          onChanged();
        } catch (err) { toast((err as Error).message, "error"); } finally { setSaving(false); }
      }}>
      <option value="">Sem responsável</option>
      {staff.map((m) => <option key={m.id} value={m.id}>{m.name}{m.employment_type ? ` · ${EMPLOYMENT_LABEL[m.employment_type]}` : ""}</option>)}
    </Select>
  );
}

function StatusActions({ task, manager, onChanged, toast }: { task: ScheduleTask; manager: boolean; onChanged: () => void; toast: Toast }) {
  const actions = statusActions(task, manager);
  const [pending, setPending] = useState<StatusAction | null>(null);
  const [reason, setReason] = useState(EMPTY_REASON);
  const [reasons] = useChangeReasons((pending && STATUS_REASON_KIND[pending.status]) || "waiting_dependency");
  const [busy, setBusy] = useState<TaskStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (actions.length === 0) return null;

  async function run(a: StatusAction, why?: string) {
    setBusy(a.status); setErr(null);
    try {
      const res = await api.setTaskStatus(task.id, a.status, why ?? null);
      toast(a.status === "completed"
        ? (res.impacted_count ? `Etapa concluída. ${plural(res.impacted_count, "etapa seguinte foi recalculada", "etapas seguintes foram recalculadas")}.` : "Etapa concluída.")
        : `Status atualizado: ${TASK_STATUS_LABEL[a.status]}.`);
      setPending(null); setReason(EMPTY_REASON);
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="tdrawer__section" aria-label="Ações">
      <h3 className="label">Ações</h3>
      {err && <Alert tone="danger">{err}</Alert>}
      {pending ? (
        <div className="stack">
          <ReasonField value={reason} onChange={setReason} reasons={reasons} autoFocus showVisibility={false}
            label={`${pending.label}: motivo`} hint="Fica no histórico interno. O cliente não vê este texto." />
          <div className="row">
            <Button variant={pending.status === "cancelled" ? "danger" : "primary"} size="sm" loading={busy === pending.status}
              disabled={!reasonIsValid(reason, reasons)} onClick={() => run(pending, reasonText(reason, reasons))}>Confirmar</Button>
            <Button variant="ghost" size="sm" onClick={() => { setPending(null); setReason(EMPTY_REASON); }}>Voltar</Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: "wrap" }}>
          {actions.map((a) => (
            <Button key={a.status} size="sm" variant={a.variant ?? "secondary"} loading={busy === a.status}
              onClick={() => (a.needsReason ? setPending(a) : run(a))}>{a.label}</Button>
          ))}
        </div>
      )}
    </section>
  );
}

function ReschedulePanel({ task, onChanged, toast }: { task: ScheduleTask; onChanged: () => void; toast: Toast }) {
  const [openPanel, setOpenPanel] = useState(false);
  const [start, setStart] = useState("");
  const [duration, setDuration] = useState("");
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [reason, setReason] = useState(EMPTY_REASON);
  const [reasons, reasonsErr] = useChangeReasons();
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const canStart = !isStarted(task);
  const canDuration = task.duration_type === "fixed" || task.duration_type === "external";

  useEffect(() => { setPreview(null); }, [start, duration]);
  if (!canStart && !canDuration) return null;

  const parsed = () => ({ s: start || null, d: duration ? Number(duration) : null });

  async function doPreview() {
    const { s, d } = parsed();
    if (!s && !d) { setErr("Informe a nova data de início ou a nova duração."); return; }
    setBusy("preview"); setErr(null);
    try { setPreview(await api.previewTaskChange(task.id, s, d)); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function doSave() {
    const { s, d } = parsed();
    setBusy("save"); setErr(null);
    try {
      const r = await api.rescheduleTaskWithReason(task.id, s, d, reason.reasonId, reason.text);
      toast(r.impacted_count ? `Prazo alterado. ${plural(r.impacted_count, "etapa recalculada", "etapas recalculadas")}.` : "Prazo alterado.");
      setOpenPanel(false); setStart(""); setDuration(""); setReason(EMPTY_REASON); setPreview(null);
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  if (!openPanel) {
    return (
      <section className="tdrawer__section">
        <Button variant="outline" size="sm" icon="calendar" onClick={() => setOpenPanel(true)}>Ajustar prazo deste projeto</Button>
      </section>
    );
  }

  return (
    <section className="tdrawer__section resched" aria-label="Ajustar prazo">
      <div className="row-between"><h3 className="label">Ajustar prazo deste projeto</h3>
        <Button variant="ghost" size="sm" onClick={() => setOpenPanel(false)}>Fechar</Button></div>
      <p className="subtext">Vale para este contrato: um atraso empurra as etapas à frente de todos os serviços dele. O padrão YouCon (Serviços e Cronogramas) não muda.</p>
      {err && <Alert tone="danger">{err}</Alert>}
      <div className="form__cols">
        {canStart && (
          <Field label="Não iniciar antes de" hint={task.planned_start_date ? `Hoje previsto: ${formatDate(task.planned_start_date, true)}` : undefined}>
            {({ id, describedBy }) => <Input id={id} type="date" aria-describedby={describedBy} value={start} onChange={(e) => setStart(e.target.value)} />}
          </Field>
        )}
        {canDuration && (
          <Field label="Duração (dias úteis)" hint={task.planned_duration_days ? `Atual: ${task.planned_duration_days}` : "Atual: a definir"}>
            {({ id, describedBy }) => <Input id={id} type="number" inputMode="numeric" min={1} max={2000} aria-describedby={describedBy}
              value={duration} onChange={(e) => setDuration(e.target.value)} />}
          </Field>
        )}
      </div>
      {!preview ? (
        <div><Button size="sm" variant="secondary" loading={busy === "preview"} onClick={doPreview}>Ver impacto</Button></div>
      ) : (
        <div className="stack">
          <ImpactPreview name={task.name} preview={preview} />
          {reasonsErr ? <Alert tone="danger">{reasonsErr}</Alert>
            : <ReasonField value={reason} onChange={setReason} reasons={reasons} />}
          <div className="row">
            <Button size="sm" loading={busy === "save"} disabled={!reasonIsValid(reason, reasons)} onClick={doSave}>Confirmar alteração</Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Cancelar</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Reabrir etapa concluída: retrabalho com prazo, prévia do impacto no contrato e motivo. */
function ReopenPanel({ task, onChanged, toast }: { task: ScheduleTask; onChanged: () => void; toast: Toast }) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState("");
  const [days, setDays] = useState("");
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [reason, setReason] = useState(EMPTY_REASON);
  const [reasons, reasonsErr] = useChangeReasons();
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setPreview(null); }, [start, days]);

  const close = () => { setOpen(false); setStart(""); setDays(""); setPreview(null); setReason(EMPTY_REASON); setErr(null); };
  async function doPreview() {
    const d = Number(days);
    if (!d || d < 1) { setErr("Informe quantos dias úteis o retrabalho vai levar."); return; }
    setBusy("preview"); setErr(null);
    try { setPreview(await api.previewTaskReopen(task.id, start || null, d)); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function doSave() {
    setBusy("save"); setErr(null);
    try {
      const r = await api.reopenTask(task.id, start || null, Number(days), reason.reasonId, reason.text);
      toast(r.impacted_count ? `Etapa reaberta. ${plural(r.impacted_count, "etapa recalculada", "etapas recalculadas")} no contrato.` : "Etapa reaberta.");
      close(); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  if (!open) {
    return (
      <section className="tdrawer__section">
        <Button variant="outline" size="sm" icon="refresh" onClick={() => setOpen(true)}>Reabrir etapa</Button>
        <p className="subtext" style={{ marginTop: 6 }}>Use quando o cliente pedir alteração em algo já entregue.</p>
      </section>
    );
  }
  return (
    <section className="tdrawer__section resched" aria-label="Reabrir etapa">
      <div className="row-between"><h3 className="label">Reabrir etapa concluída</h3>
        <Button variant="ghost" size="sm" onClick={close}>Fechar</Button></div>
      <p className="subtext">A etapa volta para “em andamento” pelo prazo do retrabalho. As etapas seguintes e todas as etapas ainda não iniciadas dos outros serviços deste contrato andam o mesmo número de dias úteis. Etapas em andamento não mudam.</p>
      {err && <Alert tone="danger">{err}</Alert>}
      <div className="form__cols">
        <Field label="Retrabalho começa em" hint="Em branco: hoje (ou o próximo dia útil).">
          {({ id, describedBy }) => <Input id={id} type="date" aria-describedby={describedBy} value={start} onChange={(e) => setStart(e.target.value)} />}
        </Field>
        <Field label="Prazo do retrabalho (dias úteis)" required>
          {({ id }) => <Input id={id} type="number" inputMode="numeric" min={1} max={2000} value={days} onChange={(e) => setDays(e.target.value)} />}
        </Field>
      </div>
      {!preview ? (
        <div><Button size="sm" variant="secondary" loading={busy === "preview"} onClick={doPreview}>Ver impacto</Button></div>
      ) : (
        <div className="stack">
          <ImpactPreview name={task.name} preview={preview} reopen />
          {reasonsErr ? <Alert tone="danger">{reasonsErr}</Alert>
            : <ReasonField value={reason} onChange={setReason} reasons={reasons} label="Motivo da reabertura" />}
          <div className="row">
            <Button size="sm" loading={busy === "save"} disabled={!reasonIsValid(reason, reasons)} onClick={doSave}>Reabrir e ajustar prazos</Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>Cancelar</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Dependencies({ task, schedule, manage, onChanged, onOpenTask, toast }: {
  task: ScheduleTask; schedule: ProjectSchedule; manage: boolean; onChanged: () => void; onOpenTask: (id: string) => void; toast: Toast;
}) {
  const byId = useMemo(() => new Map(schedule.tasks.map((t) => [t.id, t])), [schedule.tasks]);
  const trackName = (trackId: string) => serviceName(schedule.tracks.find((t) => t.id === trackId));
  const preds = predecessorsOf(task.id, schedule.dependencies);
  const succs = successorsOf(task.id, schedule.dependencies);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState(EMPTY_REASON);
  const [depReasons] = useChangeReasons("schedule");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const options = schedule.tasks.filter((t) => t.id !== task.id && !preds.some((p) => p.depends_on_task_id === t.id) && t.status !== "cancelled");

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = removing
        ? await api.removeTaskDependency(task.id, removing, reasonText(reason, depReasons))
        : await api.addTaskDependency(task.id, target, reasonText(reason, depReasons));
      toast(`${removing ? "Dependência removida" : "Dependência criada"}. ${plural(r.impacted_count, "etapa recalculada", "etapas recalculadas")}.`);
      setAdding(false); setRemoving(null); setTarget(""); setReason(EMPTY_REASON);
      onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const Item = ({ id, removable }: { id: string; removable?: boolean }) => {
    const t = byId.get(id);
    if (!t) return null;
    return (
      <li>
        <button type="button" className="deplink" onClick={() => onOpenTask(t.id)}>
          <span className={cx("task__dot", `tone-${t.status === "completed" ? "success" : t.status === "cancelled" ? "neutral" : "brand"}`)} aria-hidden="true" />
          <span className="grow truncate">{t.name} <span className="muted">· {trackName(t.schedule_track_id)}</span></span>
          <span className="muted num">{t.status === "completed" ? "Concluída" : formatDate(t.planned_end_date)}</span>
        </button>
        {removable && manage && (
          <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => { setRemoving(t.id); setAdding(false); setReason(EMPTY_REASON); }}>
            Remover dependência
          </Button>
        )}
      </li>
    );
  };

  return (
    <section className="tdrawer__section" aria-label="Dependências">
      <div className="row-between">
        <h3 className="label">Dependências</h3>
        {manage && !adding && !removing && <Button variant="ghost" size="sm" icon="plus" onClick={() => setAdding(true)}>Adicionar</Button>}
      </div>
      {preds.length === 0 && succs.length === 0 && <p className="subtext">Esta etapa não depende de outras.</p>}
      {preds.length > 0 && (<><p className="subtext">Começa depois de</p><ul className="deps">{preds.map((d) => <Item key={d.id} id={d.depends_on_task_id} removable />)}</ul></>)}
      {succs.length > 0 && (<><p className="subtext">Libera</p><ul className="deps">{succs.map((d) => <Item key={d.id} id={d.task_id} />)}</ul></>)}

      {(adding || removing) && (
        <div className="stack resched">
          {err && <Alert tone="danger">{err}</Alert>}
          {adding && (
            <Field label="Esta etapa começa depois de">
              {({ id }) => (
                <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Selecione a etapa</option>
                  {schedule.tracks.map((tr) => (
                    <optgroup key={tr.id} label={serviceName(tr)}>
                      {options.filter((o) => o.schedule_track_id === tr.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </optgroup>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {removing && <p>Remover dependência de <strong>{byId.get(removing)?.name}</strong>? As datas serão recalculadas.</p>}
          <ReasonField value={reason} onChange={setReason} reasons={depReasons} label="Motivo" showVisibility={false} />
          <div className="row">
            <Button size="sm" loading={busy} disabled={!reasonIsValid(reason, depReasons) || (adding && !target)} onClick={save}>
              {removing ? "Remover e recalcular" : "Adicionar e recalcular"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setAdding(false); setRemoving(null); setErr(null); }}>Cancelar</Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Notes({ task, version, onAdded, toast }: { task: ScheduleTask; version: number; onAdded: () => void; toast: Toast }) {
  const notes = useAsync(() => api.taskNotes(task.id), [task.id, version]);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [all, setAll] = useState(false);
  const list = notes.data ?? [];
  const shown = all ? list : list.slice(0, 3);
  async function add() {
    setSaving(true);
    try { await api.addTaskNote(task.id, value); setValue(""); toast("Observação adicionada."); onAdded(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setSaving(false); }
  }
  return (
    <section className="tdrawer__section" aria-label="Observações">
      <h3 className="label">Observações{list.length ? <span className="muted"> · {list.length}</span> : null}</h3>
      {notes.error ? <p className="subtext">{notes.error}</p> : notes.loading && !notes.data ? <Skeleton height={40} /> : list.length > 0 && (
        <ul className="notes">
          {shown.map((n) => (
            <li key={n.id} className="note">
              <span className="note__head">
                <Avatar name={n.author?.name ?? "Equipe"} size="sm" />
                <strong>{n.author?.name ?? "Equipe"}</strong>
                <span className="note__when num">{formatDateTime(n.created_at)}</span>
              </span>
              <p className="note__body">{n.body}</p>
            </li>
          ))}
          {list.length > 3 && (
            <li><Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>{all ? "Mostrar menos" : `Ver todas as ${list.length} observações`}</Button></li>
          )}
        </ul>
      )}
      <Field label="Nova observação" hint="Visível para a equipe do projeto. O cliente não vê.">
        {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="input textarea" rows={3} maxLength={4000}
          value={value} onChange={(e) => setValue(e.target.value)} placeholder="Ex.: cliente pediu duas opções de fachada" />}
      </Field>
      {value.trim() && (
        <div className="row">
          <Button size="sm" loading={saving} onClick={add}>Adicionar observação</Button>
          <Button size="sm" variant="ghost" onClick={() => setValue("")}>Descartar</Button>
        </div>
      )}
    </section>
  );
}

function History({ task, schedule, staff, version }: { task: ScheduleTask; schedule: ProjectSchedule; staff: StaffMember[]; version: number }) {
  const changes = useAsync(() => api.taskHistory(task.id), [task.id, task.status, task.planned_end_date, task.responsible_user_id]);
  const notes = useAsync(() => api.taskNotes(task.id), [task.id, version]);
  const loading = changes.loading || notes.loading;
  const error = changes.error ?? notes.error;
  // Observações entram no histórico como itens próprios, em ordem de data.
  const data: TaskChange[] | null = changes.data ? [
    ...changes.data,
    ...(notes.data ?? []).map((n) => ({ id: `note-${n.id}`, task_id: task.id, change_type: "note" as TaskChange["change_type"], before: null,
      after: { body: n.body }, reason: null, impacted_task_ids: [], created_at: n.created_at, author: n.author ?? { name: "Equipe" } })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at)) : null;
  const nameOf = (id: unknown) => staff.find((s) => s.id === id)?.name ?? (id ? "Pessoa da equipe" : "Ninguém");
  const taskName = (id: unknown) => schedule.tasks.find((t) => t.id === id)?.name ?? "etapa";

  const describe = (c: TaskChange): string | null => {
    const b = c.before ?? {}; const a = c.after ?? {};
    switch (c.change_type) {
      case "status":
        if (a.reopened) return `Concluída em ${formatDate((b.actual_end_date ?? b.planned_end_date) as string, true)} · retrabalho de ${plural(Number(a.rework_days), "dia útil", "dias úteis")}, nova entrega ${formatDate(a.planned_end_date as string, true)}`;
        return `${TASK_STATUS_LABEL[b.status as TaskStatus] ?? "—"} → ${TASK_STATUS_LABEL[a.status as TaskStatus] ?? "—"}`;
      case "responsible": return `${nameOf(b.responsible_user_id)} → ${nameOf(a.responsible_user_id)}`;
      case "reschedule": case "duration":
        return `${formatDate(b.planned_start_date as string)}–${formatDate(b.planned_end_date as string)} → ${formatDate(a.planned_start_date as string)}–${formatDate(a.planned_end_date as string)}`
          + (b.planned_duration_days !== a.planned_duration_days ? ` (${b.planned_duration_days ?? "?"} → ${a.planned_duration_days ?? "?"} dias úteis)` : "");
      case "note": return String(a.body ?? "");
      case "dependency": return a.added ? `Passa a depender de ${taskName(a.added)}` : b.removed ? `Deixa de depender de ${taskName(b.removed)}` : null;
      default: return null;
    }
  };

  return (
    <section className="tdrawer__section" aria-label="Histórico">
      <h3 className="label">Histórico</h3>
      {error ? <p className="subtext">{error}</p> : loading && !data ? <Skeleton height={48} /> :
        (data ?? []).length === 0 ? <p className="subtext">Sem alterações desde a geração do cronograma.</p> : (
          <ul className="history">
            {data!.map((c) => (
              <li key={c.id}>
                <span className="history__what">{c.change_type === "status" && c.after?.reopened ? "Etapa reaberta" : c.change_type === "note" ? "Observação" : CHANGE_LABEL[c.change_type] ?? c.change_type}</span>
                <span className="history__when num">{formatDateTime(c.created_at)}</span>
                {describe(c) && <span className="history__note">{describe(c)}</span>}
                {c.reason && <span className="history__note">Motivo: {c.reason}</span>}
                <span className="history__note muted">
                  {c.author?.name ?? "Sistema"}{c.impacted_task_ids.length > 0 ? ` · ${plural(c.impacted_task_ids.length, "etapa impactada", "etapas impactadas")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
