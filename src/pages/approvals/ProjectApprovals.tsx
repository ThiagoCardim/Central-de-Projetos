import { useMemo, useState, type ReactNode } from "react";
import { api, APPROVAL_PROOF_MAX, APPROVAL_PROOF_TYPES } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Alert, Badge, Button, Card, Field, Input, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate, plural, type Tone } from "@/utils/format";
import { todayISO } from "@/pages/schedule/model";
import type { ApprovalBoard, ApprovalProtocol, ApprovalRecord, ApprovalStatus } from "@/types/domain";

/* ==========================================================================
   Aprovações no projeto: protocolos abertos, "Projeto aprovado" com
   comprovante e inclusão de trâmites específicos no cronograma
   ========================================================================== */
export const APPROVAL_STATUS_LABEL: Record<ApprovalStatus, string> = {
  awaiting_review: "Aguardando conferência",
  proof_rejected: "Comprovante recusado",
  to_release: "A liberar",
  released: "Liberada",
  paid: "Paga",
  cancelled: "Cancelada",
};
export const APPROVAL_STATUS_TONE: Record<ApprovalStatus, Tone> = {
  awaiting_review: "warning", proof_rejected: "danger", to_release: "brand", released: "neutral", paid: "success", cancelled: "neutral",
};

/** Abre o comprovante privado num link temporário. */
export function ProofLink({ path, name, compact }: { path: string; name: string; compact?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={cx("proof", compact && "proof--compact")} disabled={busy} title={`Abrir ${name}`}
      onClick={async () => {
        setBusy(true);
        const w = window.open("", "_blank");
        try { const url = await api.approvalProofUrl(path); if (w) w.location.href = url; else window.location.href = url; }
        catch (err) { w?.close(); toast((err as Error).message, "error"); }
        finally { setBusy(false); }
      }}>
      <Icon name="paperclip" size={14} />
      <span className="truncate">{compact ? "Comprovante" : name}</span>
    </button>
  );
}

export function ProjectApprovalsCard({ projectId, onScheduleChanged }: { projectId: string; onScheduleChanged?: () => void }) {
  const q = useAsync(() => api.projectApprovalBoard(projectId), [projectId]);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [resubmit, setResubmit] = useState<ApprovalRecord | null>(null);
  const [includeOpen, setIncludeOpen] = useState(false);
  const b = q.data;

  if (q.loading && !b) return <Card title="Aprovações"><Skeleton height={64} radius={10} /></Card>;
  if (!b || (b.protocols.length === 0 && !b.can_include)) return null;

  const byType = new Map(b.approvals.map((a) => [a.type_id, a]));
  const open = b.protocols.filter((p) => !p.approval_id);
  const approved = b.approvals.filter((a) => a.status !== "proof_rejected").length;
  const tramitesLeft = b.tramites.filter((t) => !t.included).length;

  return (
    <Card title="Aprovações" count={b.protocols.length ? `${approved}/${b.protocols.length}` : undefined} className="papr"
      action={b.can_register && open.length > 0 ? <Button size="sm" icon="seal" onClick={() => setRegisterOpen(true)}>Projeto aprovado</Button> : undefined}>
      {b.protocols.length === 0 ? (
        <p className="subtext">Este projeto ainda não tem protocolos de aprovação. Inclua um trâmite quando o cliente precisar.</p>
      ) : (
        <ul className="papr__list">
          {b.protocols.map((p) => {
            const a = byType.get(p.type_id);
            return (
              <li key={p.type_id} className="papr__row">
                <span className={cx("papr__dot", a && a.status !== "proof_rejected" && "is-done", a?.status === "proof_rejected" && "is-bad")} aria-hidden="true">
                  {a && a.status !== "proof_rejected" ? <Icon name="check" size={12} /> : null}
                </span>
                <div className="grow papr__main">
                  <span className="papr__name">{p.type_name}</span>
                  <span className="papr__meta">
                    {a ? <>Aprovado em {formatDate(a.approved_on, true)}{a.protocol_number ? ` · Protocolo ${a.protocol_number}` : ""}</>
                      : p.service_name !== p.type_name && !p.service_name.includes(p.type_name) ? p.service_name : "Protocolo em andamento"}
                  </span>
                  {a?.status === "proof_rejected" && a.review_note && (
                    <span className="papr__note"><Icon name="alertCircle" size={13} /> {a.review_note}</span>
                  )}
                </div>
                <div className="papr__side">
                  {a ? <ApprovalBadge status={a.status} project /> : <Badge>Em andamento</Badge>}
                  {a && <ProofLink path={a.proof.path} name={a.proof.name} compact />}
                  {a?.can_resubmit && <Button size="sm" variant="secondary" onClick={() => setResubmit(a)}>Reenviar</Button>}
                  {a?.can_review && <Link to="/aprovacoes" className="btn btn--outline btn--sm">Conferir</Link>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {b.can_include && tramitesLeft > 0 && (
        <div className="card__note papr__foot">
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setIncludeOpen(true)}>Incluir trâmite no cronograma</Button>
          <span className="subtext">Terraplanagem, Demolição, CINDACTA e outros</span>
        </div>
      )}

      <RegisterApprovalModal open={registerOpen} projectId={projectId} protocols={open}
        onClose={() => setRegisterOpen(false)} onDone={() => { setRegisterOpen(false); void q.reload(); onScheduleChanged?.(); }} />
      <RegisterApprovalModal open={!!resubmit} projectId={projectId} resubmit={resubmit}
        protocols={resubmit ? b.protocols.filter((p) => p.type_id === resubmit.type_id) : []}
        onClose={() => setResubmit(null)} onDone={() => { setResubmit(null); void q.reload(); }} />
      <IncludeTramiteModal open={includeOpen} projectId={projectId} board={b}
        onClose={() => setIncludeOpen(false)} onDone={() => { setIncludeOpen(false); void q.reload(); onScheduleChanged?.(); }} />
    </Card>
  );
}

/** No projeto, comissão é assunto interno: mostra só se está aprovado ou se precisa de ação. */
export function ApprovalBadge({ status, project }: { status: ApprovalStatus; project?: boolean }) {
  if (project && (status === "to_release" || status === "released" || status === "paid")) return <Badge tone="success" dot>Aprovado</Badge>;
  return <Badge tone={APPROVAL_STATUS_TONE[status]} dot>{APPROVAL_STATUS_LABEL[status]}</Badge>;
}

/* ---------- "Projeto aprovado" ---------- */
type Draft = { checked: boolean; date: string; protocol: string; file: File | null };

export function RegisterApprovalModal({ open, projectId, protocols, resubmit, onClose, onDone }: {
  open: boolean; projectId: string; protocols: ApprovalProtocol[]; resubmit?: ApprovalRecord | null; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = `${open}-${resubmit?.id ?? ""}-${protocols.map((p) => p.type_id).join(",")}`;
  const [lastKey, setLastKey] = useState("");
  if (open && key !== lastKey) {
    setLastKey(key);
    setErr(null);
    setDrafts(Object.fromEntries(protocols.map((p) => [p.type_id, {
      checked: !!resubmit || protocols.length === 1, date: resubmit?.approved_on ?? todayISO(), protocol: resubmit?.protocol_number ?? "", file: null,
    }])));
  }
  const chosen = protocols.filter((p) => drafts[p.type_id]?.checked);
  const missing = chosen.filter((p) => !drafts[p.type_id]?.file || !drafts[p.type_id]?.date);
  const set = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  async function submit() {
    setBusy(true); setErr(null);
    const done: string[] = [];
    try {
      for (const p of chosen) {
        const d = drafts[p.type_id];
        await api.registerApproval({ id: resubmit?.id, project_id: projectId, type_id: p.type_id, approved_on: d.date, protocol: d.protocol, file: d.file! });
        done.push(p.type_name);
        set(p.type_id, { checked: false });
      }
      toast(resubmit ? "Comprovante reenviado para conferência." : `${plural(done.length, "aprovação registrada", "aprovações registradas")}. A liderança de aprovação vai conferir o comprovante.`);
      onDone();
    } catch (e) {
      setErr(done.length ? `${done.join(", ")} registrad${done.length > 1 ? "as" : "a"}. ${(e as Error).message}` : (e as Error).message);
      if (done.length) onDone();
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} wide title={resubmit ? `Reenviar comprovante · ${resubmit.type_name}` : "Projeto aprovado"}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="seal" loading={busy} disabled={chosen.length === 0 || missing.length > 0} onClick={submit}>
          {resubmit ? "Reenviar" : chosen.length > 1 ? `Registrar ${chosen.length} aprovações` : "Registrar aprovação"}
        </Button>
      </>}>
      <div className="aprm">
        {resubmit?.review_note
          ? <Alert tone="danger" title="Motivo da recusa">{resubmit.review_note}</Alert>
          : !resubmit && <p>Marque os protocolos que foram aprovados e anexe o comprovante de cada um (PDF ou imagem).</p>}
        {protocols.length === 0 && <p className="subtext">Todos os protocolos deste projeto já foram registrados.</p>}
        {protocols.map((p) => {
          const d = drafts[p.type_id];
          if (!d) return null;
          return (
            <div key={p.type_id} className={cx("aprm__item", d.checked && "is-on")}>
              {!resubmit && (
                <label className="aprm__check">
                  <input type="checkbox" checked={d.checked} onChange={(e) => set(p.type_id, { checked: e.target.checked })} />
                  <span><strong>{p.type_name}</strong>{p.service_name !== p.type_name && <span className="subtext"> · {p.service_name}</span>}</span>
                </label>
              )}
              {d.checked && (
                <div className="aprm__fields">
                  <Field label="Data da aprovação" required>
                    {({ id }) => <Input id={id} type="date" value={d.date} max={todayISO()} onChange={(e) => set(p.type_id, { date: e.target.value })} />}
                  </Field>
                  <Field label="Nº do protocolo" hint="Opcional">
                    {({ id }) => <Input id={id} value={d.protocol} maxLength={80} onChange={(e) => set(p.type_id, { protocol: e.target.value })} />}
                  </Field>
                  <FilePick label="Comprovante da aprovação" file={d.file} onPick={(f) => set(p.type_id, { file: f })} />
                </div>
              )}
            </div>
          );
        })}
        {!resubmit && <p className="subtext aprm__hint">Não encontrou o protocolo? Inclua o trâmite no cronograma do projeto primeiro.</p>}
        {err && <Alert tone="danger">{err}</Alert>}
      </div>
    </Modal>
  );
}

function FilePick({ label, file, onPick }: { label: string; file: File | null; onPick: (f: File | null) => void }) {
  const [warn, setWarn] = useState<string | null>(null);
  return (
    <Field label={label} required error={warn} hint="PDF, JPG, PNG ou WebP, até 10 MB">
      {({ id, describedBy }) => (
        <label className={cx("filepick", file && "has-file")} htmlFor={id}>
          <input id={id} aria-describedby={describedBy} type="file" accept={APPROVAL_PROOF_TYPES.join(",")} className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f && !APPROVAL_PROOF_TYPES.includes(f.type)) { setWarn("Use PDF ou imagem (JPG, PNG ou WebP)."); onPick(null); return; }
              if (f && f.size > APPROVAL_PROOF_MAX) { setWarn("O arquivo passa de 10 MB."); onPick(null); return; }
              setWarn(null); onPick(f);
            }} />
          <Icon name={file ? "file" : "paperclip"} size={16} />
          <span className="truncate">{file ? file.name : "Escolher arquivo"}</span>
          {file && <span className="filepick__size">{(file.size / 1024 / 1024).toFixed(1).replace(".", ",")} MB</span>}
        </label>
      )}
    </Field>
  );
}

/* ---------- Incluir trâmite no cronograma ---------- */
export function IncludeTramiteModal({ open, projectId, board, onClose, onDone }: {
  open: boolean; projectId: string; board: ApprovalBoard | null; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const items = useMemo(() => board?.tramites ?? [], [board]);

  async function submit() {
    setBusy(true); setErr(null);
    let n = 0;
    try {
      for (const id of sel) { await api.includeTramite(projectId, id); n += 1; }
      toast(`${plural(n, "trâmite incluído", "trâmites incluídos")} no cronograma. O cliente já acompanha.`);
      setSel([]); onDone();
    } catch (e) { setErr((e as Error).message); if (n) onDone(); }
    finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Incluir trâmite no cronograma"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="plus" loading={busy} disabled={sel.length === 0} onClick={submit}>{sel.length > 1 ? `Incluir ${sel.length}` : "Incluir"}</Button>
      </>}>
      <p>Cada trâmite entra como uma trilha própria no cronograma, com a etapa de aprovação no órgão. O cliente acompanha no cronograma de entregas.</p>
      <div className="tram">
        {items.map((t) => (
          <label key={t.service_id} className={cx("tram__item", t.included && "is-done")}>
            <input type="checkbox" disabled={t.included} checked={t.included || sel.includes(t.service_id)}
              onChange={(e) => setSel((s) => (e.target.checked ? [...s, t.service_id] : s.filter((x) => x !== t.service_id)))} />
            <span className="grow">{t.name}</span>
            {t.included && <span className="subtext">Já no cronograma</span>}
          </label>
        ))}
      </div>
      {err && <Alert tone="danger">{err}</Alert>}
    </Modal>
  );
}

export function Money({ value, muted }: { value: number | null; muted?: ReactNode }) {
  if (value == null) return <span className="money is-empty">{muted ?? "A definir"}</span>;
  return <span className="money">{value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</span>;
}

/** Botão do cronograma: carrega os trâmites ao abrir. */
export function IncludeTramiteButton({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const board = useAsync(() => (open ? api.projectApprovalBoard(projectId) : Promise.resolve(null)), [open, projectId]);
  return (
    <>
      <Button variant="outline" icon="seal" onClick={() => setOpen(true)}>Incluir trâmite</Button>
      <IncludeTramiteModal open={open && !!board.data} projectId={projectId} board={board.data ?? null}
        onClose={() => setOpen(false)} onDone={() => { setOpen(false); onDone(); }} />
    </>
  );
}
