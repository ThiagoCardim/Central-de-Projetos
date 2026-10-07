import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { ADJ_IMAGE_MAX, ADJ_IMAGE_TYPES, api } from "@/services/api";
import { Alert, Avatar, Badge, Button, Card, EmptyState, Field, Input, LoadError, Segmented, Select, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { AdjustmentAttachment, AdjustmentComplexity, AdjustmentRequest, ProjectSchedule, SchedulePreview, ScheduleTask, StaffMember } from "@/types/domain";
import { cx, formatDate, formatDateTime, plural, TASK_STATUS_LABEL } from "@/utils/format";
import { ImpactPreview } from "./ImpactPreview";

const ELIGIBLE = new Set(["completed", "in_progress", "waiting_client", "waiting_third_party", "waiting_dependency"]);
export const canRequestAdjustment = (t: ScheduleTask) =>
  ELIGIBLE.has(t.status) && (t.duration_type === "fixed" || t.duration_type === "external");

const STATUS: Record<AdjustmentRequest["status"], { label: string; tone: "warning" | "success" | "danger" | "neutral" }> = {
  pending: { label: "Aguardando aprovação", tone: "warning" },
  approved: { label: "Aprovado", tone: "success" },
  rejected: { label: "Recusado", tone: "danger" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

let complexCache: Promise<AdjustmentComplexity[]> | null = null;
export function loadComplexities(refresh = false) {
  if (!complexCache || refresh) complexCache = api.listAdjustmentComplexities().catch((e) => { complexCache = null; throw e; });
  return complexCache;
}
function useComplexities() {
  const [list, setList] = useState<AdjustmentComplexity[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadComplexities().then((x) => alive && setList(x)).catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, []);
  return [list, err] as const;
}

const serviceOfTrack = (s: ProjectSchedule, trackId: string) => s.tracks.find((t) => t.id === trackId)?.project_service?.service?.name ?? "Serviço";

/* ==========================================================================
   Lista de ajustes do projeto (aba "Ajustes" do cronograma)
   ========================================================================== */
export function AdjustmentsView({ items, error, loading, onRetry, schedule, staff, onRequest, onChanged, onOpenTask }: {
  items: AdjustmentRequest[] | null; error: string | null; loading: boolean; onRetry: () => void;
  schedule: ProjectSchedule; staff: StaffMember[]; onRequest: () => void; onChanged: () => void; onOpenTask: (id: string) => void;
}) {
  const toast = useToast();
  const [deciding, setDeciding] = useState<AdjustmentRequest | null>(null);
  const pending = (items ?? []).filter((r) => r.status === "pending");
  const done = (items ?? []).filter((r) => r.status !== "pending");

  return (
    <div className="stack">
      <div className="row-between adj-head">
        <p className="subtext">
          Quando um setor precisa que outro reveja algo já feito (ex.: o Estrutural pede um ajuste na Arquitetura), registre aqui.
          O líder do setor requisitado aprova, define o prazo e quem executa; o cronograma do contrato se ajusta sozinho.
        </p>
        <Button icon="refresh" onClick={onRequest}>Solicitar ajuste</Button>
      </div>
      {error ? <LoadError message={error} onRetry={onRetry} /> : loading && !items ? <Skeleton height={160} radius={16} /> :
        (items ?? []).length === 0 ? (
          <Card><EmptyState compact icon="refresh" title="Nenhum pedido de ajuste neste projeto."
            text="Pedidos entre setores, com aprovação do líder e prazo pela complexidade, aparecem aqui." /></Card>
        ) : (
          <>
            {pending.length > 0 && <h3 className="label">Aguardando aprovação · {pending.length}</h3>}
            {pending.map((r) => (
              <AdjustmentCard key={r.id} r={r} onOpenTask={onOpenTask}
                actions={<>
                  {r.can_decide && <Button size="sm" onClick={() => setDeciding(r)}>Analisar pedido</Button>}
                  {r.can_cancel && <Button size="sm" variant="ghost" onClick={async () => {
                    try { await api.cancelAdjustment(r.id); toast("Pedido cancelado."); onChanged(); }
                    catch (e) { toast((e as Error).message, "error"); }
                  }}>Cancelar pedido</Button>}
                </>} />
            ))}
            {done.length > 0 && <h3 className="label">Histórico</h3>}
            {done.map((r) => <AdjustmentCard key={r.id} r={r} onOpenTask={onOpenTask} />)}
          </>
        )}
      {deciding && (
        <DecideAdjustmentModal request={deciding} schedule={schedule} staff={staff} onClose={() => setDeciding(null)}
          onDone={(msg) => { setDeciding(null); toast(msg); onChanged(); }} />
      )}
    </div>
  );
}

function AdjustmentCard({ r, actions, onOpenTask }: { r: AdjustmentRequest; actions?: ReactNode; onOpenTask: (id: string) => void }) {
  const st = STATUS[r.status];
  return (
    <Card className={cx("adj", r.status === "pending" && "adj--pending")}>
      <div className="adj__top">
        <div className="adj__title">
          <button type="button" className="linklike" onClick={() => onOpenTask(r.task_id)}><strong>{r.target_service} · {r.task_name}</strong></button>
          <span className="subtext">
            {r.from_service ? <>Pedido pelo setor {r.from_service} · </> : null}
            {r.requested_by.name} · {formatDateTime(r.created_at)}
          </span>
        </div>
        <Badge tone={st.tone} dot>{st.label}</Badge>
      </div>
      <p className="adj__desc">{r.description}</p>
      {r.attachments?.length > 0 && <AttachmentGallery files={r.attachments} />}
      <div className="adj__meta">
        <span className="adj__cplx"><Icon name="clock" size={14} /> {r.complexity_label} · {plural(r.approved_days ?? r.requested_days, "dia útil", "dias úteis")}</span>
        {r.status === "pending" && r.approvers.length > 0 && (
          <span className="subtext">Aprovação: {r.approvers.map((a) => a.name).join(", ")}</span>
        )}
        {r.status === "approved" && (
          <span className="subtext">
            Aprovado por {r.decided_by?.name}{r.assignee ? <> · executa: <strong>{r.assignee.name}</strong></> : null}
            {r.result?.mode === "reopened" ? " · etapa reaberta" : r.result?.mode === "extended" ? " · prazo da etapa estendido" : ""}
            {r.result?.impacted_count ? ` · ${plural(r.result.impacted_count, "etapa recalculada", "etapas recalculadas")}` : ""}
          </span>
        )}
        {r.status === "rejected" && <span className="subtext">Recusado por {r.decided_by?.name}</span>}
      </div>
      {r.decision_note && <p className="adj__note"><span className="label">Resposta do líder</span> {r.decision_note}</p>}
      {actions && <div className="row">{actions}</div>}
    </Card>
  );
}

/* ==========================================================================
   Solicitar ajuste
   ========================================================================== */
export function RequestAdjustmentModal({ projectId, schedule, initialTaskId, onClose, onDone }: {
  projectId: string; schedule: ProjectSchedule; initialTaskId?: string | null; onClose: () => void; onDone: () => void;
}) {
  const [images, setImages] = useState<File[]>([]);
  const toast = useToast();
  const [complexities, cErr] = useComplexities();
  const initialTask = schedule.tasks.find((t) => t.id === initialTaskId) ?? null;
  const [track, setTrack] = useState(initialTask?.schedule_track_id ?? "");
  const [taskId, setTaskId] = useState(initialTask?.id ?? "");
  const [from, setFrom] = useState("");
  const [cplx, setCplx] = useState<string>("");
  const [days, setDays] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tracks = schedule.tracks.filter((t) => schedule.tasks.some((x) => x.schedule_track_id === t.id && canRequestAdjustment(x)));
  const steps = schedule.tasks.filter((t) => t.schedule_track_id === track && canRequestAdjustment(t)).sort((a, b) => a.sequence - b.sequence);
  const targetPs = schedule.tracks.find((t) => t.id === track)?.project_service_id;
  const pick = (code: string) => { setCplx(code); setDays(String(complexities?.find((c) => c.code === code)?.default_days ?? "")); };

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const reqId = await api.createAdjustment({ taskId, complexity: cplx, description: desc, days: days ? Number(days) : null, fromService: from || null });
      if (images.length > 0) {
        try { await api.uploadAdjustmentImages(projectId, reqId, images); }
        catch (e) {
          toast(`Pedido enviado, mas as imagens não foram anexadas: ${(e as Error).message}`, "error");
          onDone(); return;
        }
      }
      toast(images.length ? `Pedido enviado com ${plural(images.length, "imagem", "imagens")}.` : "Pedido enviado ao líder do setor.");
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open wide onClose={onClose} title="Solicitar ajuste a outro setor"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} disabled={!taskId || !cplx || !days || desc.trim().length < 5} onClick={submit}>Enviar para aprovação</Button>
      </>}>
      <div className="form">
        <p className="subtext">O pedido vai para o líder da área do setor escolhido. Nada muda no cronograma até ele aprovar.</p>
        {err && <Alert tone="danger">{err}</Alert>}
        <div className="form__cols">
          <Field label="Setor que precisa ajustar" required>
            {({ id }) => (
              <Select id={id} value={track} onChange={(e) => { setTrack(e.target.value); setTaskId(""); }}>
                <option value="" disabled>Escolha o serviço</option>
                {tracks.map((t) => <option key={t.id} value={t.id}>{t.project_service?.service?.name}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Etapa a ajustar" required hint={track && steps.length === 0 ? "Nenhuma etapa concluída ou em andamento neste serviço." : undefined}>
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} value={taskId} disabled={!track} onChange={(e) => setTaskId(e.target.value)}>
                <option value="" disabled>Escolha a etapa</option>
                {steps.map((t) => <option key={t.id} value={t.id}>{t.name} · {TASK_STATUS_LABEL[t.status]}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Setor que está pedindo" hint="Opcional. Ajuda o líder a entender a origem do pedido.">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Não informar</option>
              {schedule.tracks.filter((t) => t.project_service_id !== targetPs).map((t) => (
                <option key={t.id} value={t.project_service_id}>{t.project_service?.service?.name}</option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="cplx-pick">
          <legend className="field__label">Complexidade do ajuste <span className="req">*</span></legend>
          {cErr ? <Alert tone="danger">{cErr}</Alert> : !complexities ? <Skeleton height={72} /> : (
            <div className="cplx-pick__grid">
              {complexities.map((c) => (
                <button key={c.code} type="button" className={cx("cplx", cplx === c.code && "is-on")} aria-pressed={cplx === c.code} onClick={() => pick(c.code)}>
                  <span className="cplx__label">{c.label}</span>
                  <span className="cplx__days num">{plural(c.default_days, "dia útil", "dias úteis")}</span>
                  {c.description && <span className="cplx__desc">{c.description}</span>}
                </button>
              ))}
            </div>
          )}
        </fieldset>
        {cplx && (
          <Field label="Prazo sugerido (dias úteis)" hint="Vem da tabela de prazos. Ajuste se precisar; o líder confirma na aprovação.">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="number" min={1} max={2000} value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        )}
        <Field label="O que precisa ser ajustado" required>
          {({ id }) => <textarea id={id} className="input textarea" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)}
            placeholder="Ex.: pilar central conflita com a laje da sala; ajustar o vão e reposicionar a escada" />}
        </Field>
        <ImagePicker files={images} onChange={setImages} />
      </div>
    </Modal>
  );
}

/* ==========================================================================
   Aprovar / recusar (líder do setor requisitado)
   ========================================================================== */
function DecideAdjustmentModal({ request: r, schedule, staff, onClose, onDone }: {
  request: AdjustmentRequest; schedule: ProjectSchedule; staff: StaffMember[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [complexities] = useComplexities();
  const task = schedule.tasks.find((t) => t.id === r.task_id) ?? null;
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [cplx, setCplx] = useState<string>(r.complexity);
  const [days, setDays] = useState(String(r.requested_days));
  const [assignee, setAssignee] = useState(task?.responsible_user_id ?? "");
  const [start, setStart] = useState("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setPreview(null); }, [days, start]);

  const people = useMemo(() => staff.filter((m) => m.role === "collaborator" || m.role === "leader" || m.role === "unit_admin"), [staff]);
  const completed = task?.status === "completed";

  async function doPreview() {
    if (!task) return;
    setBusy("preview"); setErr(null);
    try {
      setPreview(completed
        ? await api.previewTaskReopen(task.id, start || null, Number(days))
        : await api.previewTaskChange(task.id, null, (task.planned_duration_days ?? 0) + Number(days)));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  async function submit() {
    setBusy("save"); setErr(null);
    try {
      if (decision === "approve") {
        const res = await api.decideAdjustment({ id: r.id, approve: true, note, days: Number(days), assignee, start: completed ? start : null });
        onDone(res.impacted_count ? `Ajuste aprovado. ${plural(res.impacted_count, "etapa recalculada", "etapas recalculadas")} no contrato.` : "Ajuste aprovado.");
      } else {
        await api.decideAdjustment({ id: r.id, approve: false, note });
        onDone("Pedido recusado. Quem pediu foi avisado.");
      }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <Modal open wide onClose={onClose} title="Analisar pedido de ajuste"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        {decision === "approve"
          ? <Button loading={busy === "save"} disabled={!assignee || !days || Number(days) < 1} onClick={submit}>Aprovar e ajustar cronograma</Button>
          : <Button variant="danger" loading={busy === "save"} disabled={note.trim().length < 3} onClick={submit}>Recusar pedido</Button>}
      </>}>
      <div className="form">
        <div className="adj-sum">
          <p><strong>{r.target_service} · {r.task_name}</strong> <span className="subtext">({task ? TASK_STATUS_LABEL[task.status] : "—"})</span></p>
          <p className="subtext">Pedido por {r.requested_by.name}{r.from_service ? `, do setor ${r.from_service}` : ""} · {formatDateTime(r.created_at)}</p>
          <p className="adj__desc">{r.description}</p>
          {r.attachments?.length > 0 && <AttachmentGallery files={r.attachments} />}
        </div>
        {err && <Alert tone="danger">{err}</Alert>}
        <Segmented<"approve" | "reject"> label="Decisão" value={decision} onChange={setDecision}
          options={[{ value: "approve", label: "Aprovar" }, { value: "reject", label: "Recusar" }]} />

        {decision === "approve" ? (
          <>
            <div className="form__cols">
              <Field label="Complexidade">
                {({ id }) => (
                  <Select id={id} value={cplx} onChange={(e) => { setCplx(e.target.value); const c = complexities?.find((x) => x.code === e.target.value); if (c) setDays(String(c.default_days)); }}>
                    {(complexities ?? []).map((c) => <option key={c.code} value={c.code}>{c.label} · {c.default_days} d.u.</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Prazo do ajuste (dias úteis)" required>
                {({ id }) => <Input id={id} type="number" min={1} max={2000} value={days} onChange={(e) => setDays(e.target.value)} />}
              </Field>
            </div>
            <div className="form__cols">
              <Field label="Quem executa o ajuste" required>
                {({ id }) => (
                  <Select id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                    <option value="" disabled>Escolha o colaborador</option>
                    {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                )}
              </Field>
              {completed && (
                <Field label="Ajuste começa em" hint="Em branco: hoje (ou o próximo dia útil).">
                  {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}
                </Field>
              )}
            </div>
            <p className="subtext">
              {completed
                ? "A etapa está concluída: ela será reaberta pelo prazo do ajuste com o colaborador escolhido."
                : `A etapa está em andamento: ganha ${plural(Number(days) || 0, "dia útil", "dias úteis")} a mais.`}
              {" "}As etapas à frente, em todos os serviços do contrato, andam junto.
            </p>
            {!preview
              ? <div><Button size="sm" variant="secondary" loading={busy === "preview"} onClick={doPreview}>Ver impacto no cronograma</Button></div>
              : <ImpactPreview name={r.task_name} preview={preview} reopen={completed} />}
            <Field label="Observação para quem pediu" hint="Opcional.">
              {({ id }) => <textarea id={id} className="input textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label="Por que o ajuste não será feito" required>
            {({ id }) => <textarea id={id} className="input textarea" rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Ex.: a solução proposta já foi aprovada pelo cliente; resolver na compatibilização" />}
          </Field>
        )}
      </div>
    </Modal>
  );
}

/* ==========================================================================
   Tela inicial do líder: pedidos aguardando a sua aprovação
   ========================================================================== */
export function PendingAdjustmentsCard({ items, onOpen }: { items: AdjustmentRequest[]; onOpen: (r: AdjustmentRequest) => void }) {
  if (items.length === 0) return null;
  return (
    <Card title="Ajustes aguardando sua aprovação" count={items.length} flush>
      <ul className="adj-list">
        {items.map((r) => (
          <li key={r.id}>
            <button type="button" className="adj-list__item" onClick={() => onOpen(r)}>
              <Avatar name={r.requested_by.name} size="sm" />
              <span className="grow">
                <span className="adj-list__title">{r.target_service} · {r.task_name}</span>
                <span className="subtext">{r.project_code ?? r.project_name} · {r.complexity_label} · pedido por {r.requested_by.name}{r.from_service ? ` (${r.from_service})` : ""}</span>
              </span>
              <span className="subtext num">{formatDate(r.created_at.slice(0, 10))}</span>
              <Icon name="chevronRight" size={16} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ==========================================================================
   Imagens do pedido
   ========================================================================== */
const MAX_IMAGES = 6;
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Anexar imagens: clicar, arrastar ou colar (Ctrl+V) um print. */
function ImagePicker({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function add(list: FileList | File[]) {
    const incoming = Array.from(list);
    const bad = incoming.find((f) => !ADJ_IMAGE_TYPES.includes(f.type));
    const big = incoming.find((f) => f.size > ADJ_IMAGE_MAX);
    const ok = incoming.filter((f) => ADJ_IMAGE_TYPES.includes(f.type) && f.size <= ADJ_IMAGE_MAX);
    const next = [...files, ...ok].slice(0, MAX_IMAGES);
    setErr(bad ? `“${bad.name}” não é JPG, PNG ou WebP.` : big ? `“${big.name}” passa de 8 MB.`
      : files.length + ok.length > MAX_IMAGES ? `Até ${MAX_IMAGES} imagens por pedido.` : null);
    onChange(next);
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) add(e.dataTransfer.files); };
  const onPaste = (e: ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); add(imgs.map((f, i) => new File([f], f.name && f.name !== "image.png" ? f.name : `print-${Date.now()}-${i + 1}.png`, { type: f.type }))); }
  };

  return (
    <div className="imgpick">
      <span className="field__label">Imagens do que precisa ser ajustado <span className="muted">(opcional)</span></span>
      <div className={cx("imgpick__drop", over && "is-over")} tabIndex={0} role="button"
        aria-label="Anexar imagens: clique, arraste ou cole um print"
        onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} onPaste={onPaste}>
        <Icon name="plus" size={18} />
        <span><strong>Clique para escolher</strong>, arraste ou cole um print (Ctrl+V)</span>
        <span className="subtext">JPG, PNG ou WebP · até {MAX_IMAGES} imagens de 8 MB</span>
      </div>
      <input ref={input} type="file" accept={ADJ_IMAGE_TYPES.join(",")} multiple hidden
        onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
      {err && <p className="field__error" role="alert">{err}</p>}
      {files.length > 0 && (
        <ul className="imgpick__list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="imgthumb">
              <img src={previews[i]} alt={f.name} />
              <span className="imgthumb__name" title={f.name}>{f.name}</span>
              <span className="imgthumb__size">{fmtSize(f.size)}</span>
              <button type="button" className="imgthumb__remove" aria-label={`Remover ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Miniaturas das imagens anexadas (links temporários); clique abre a imagem. */
function AttachmentGallery({ files }: { files: AdjustmentAttachment[] }) {
  const [urls, setUrls] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<AdjustmentAttachment | null>(null);
  useEffect(() => {
    let alive = true;
    api.adjustmentImageUrls(files.map((f) => f.path)).then((u) => alive && setUrls(u)).catch(() => alive && setErr(true));
    return () => { alive = false; };
  }, [files]);
  if (err) return <p className="subtext">Não foi possível carregar as imagens anexadas.</p>;
  return (
    <>
      <ul className="imggal" aria-label="Imagens anexadas">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className="imggal__item" onClick={() => setOpen(f)} title={f.name} disabled={!urls?.[f.path]}>
              {urls?.[f.path] ? <img src={urls[f.path]} alt={f.name} loading="lazy" /> : <Skeleton height={72} />}
            </button>
          </li>
        ))}
      </ul>
      {open && urls?.[open.path] && (
        <Modal open wide onClose={() => setOpen(null)} title={open.name}
          footer={<>
            <a className="btn btn--ghost btn--sm" href={urls[open.path]} target="_blank" rel="noreferrer">Abrir em nova aba</a>
            <Button size="sm" onClick={() => setOpen(null)}>Fechar</Button>
          </>}>
          <img className="imgview" src={urls[open.path]} alt={open.name} />
        </Modal>
      )}
    </>
  );
}

export { serviceOfTrack };
