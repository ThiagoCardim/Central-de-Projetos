import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Badge, Button, Card, EmptyState, Input, LoadError, Segmented, Select, Skeleton } from "@/components/ui/primitives";
import { ConfirmDialog, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate, formatDateTime, plural } from "@/utils/format";
import type { DeliveryBoard, DeliveryFile, DeliveryItem, DeliveryRequest, DeliveryVersion } from "@/types/domain";
import { AREA_LABEL, STATUS_TONE, extrasApproved, fmtSize, nextKind, remaining, statusLabel, versionBadge } from "./deliveriesUi";

/* ==========================================================================
   Entregas do projeto: uma área por serviço contratado.
   Criação (apresentação + revisões) → aprovação → detalhamento → projeto final.
   ========================================================================== */
export interface Person { id: string; name: string }

export function DeliveriesView({ projectId, people = [], initialKey }: { projectId: string; people?: Person[]; initialKey?: string | null }) {
  const q = useAsync(() => api.projectDeliveries(projectId), [projectId]);
  const [key, setKey] = useState<string | null>(initialKey ?? null);
  const b = q.data;

  const all = useMemo(() => (b ? [...b.items, ...(b.general.versions.length || b.can_work ? [b.general] : [])] : []), [b]);
  useEffect(() => {
    if (!b || (key && all.some((i) => i.key === key))) return;
    // Abre primeiro o que pede ação: do cliente (avaliar) ou da equipe (revisão pedida).
    const first = all.find((i) => i.status === (b.is_client ? "awaiting_client" : "revision_requested"))
      ?? all.find((i) => i.versions.length > 0) ?? all[0];
    setKey(first?.key ?? null);
  }, [b, all, key]);

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!b) return <div className="dlv"><Skeleton height={420} radius={16} /></div>;
  if (all.length === 0) return <Card><EmptyState icon="folder" title="Nenhum serviço contratado ainda." /></Card>;
  const cur = all.find((i) => i.key === key) ?? all[0];

  return (
    <div className="dlv">
      <nav className="dlv__rail" aria-label="Serviços">
        {all.map((it) => (
          <button key={it.key} type="button" className={cx("dlvsvc", it.key === cur.key && "is-on")} aria-current={it.key === cur.key || undefined} onClick={() => setKey(it.key)}>
            <span className="dlvsvc__name">{it.name}</span>
            <span className="dlvsvc__meta">
              <span className={cx("dlvsvc__dot", `is-${STATUS_TONE[it.status]}`)} aria-hidden="true" />
              {statusLabel(it, b.is_client)}
              {it.revisions_enabled && <span className="dlvsvc__rounds num">{it.used}/{it.allowed}</span>}
            </span>
          </button>
        ))}
      </nav>
      <ServicePanel key={cur.key} board={b} it={cur} people={people} onChanged={() => void q.reload()} />
    </div>
  );
}

/* ---------- Painel de um serviço ---------- */
function ServicePanel({ board, it, people, onChanged }: { board: DeliveryBoard; it: DeliveryItem; people: Person[]; onChanged: () => void }) {
  const client = board.is_client;
  const draft = it.versions.find((v) => v.is_draft) ?? null;
  const published = it.versions.filter((v) => !v.is_draft);
  const current = published.find((v) => v.id === (it.status === "final" || it.status === "delivered" || !it.revisions_enabled ? it.last_final_version_id : it.last_creation_version_id))
    ?? published[0] ?? null;
  const next = board.can_work ? nextKind(it) : null;
  const pendingExtra = it.extras.find((e) => e.status === "pending");
  const [modal, setModal] = useState<null | "revision" | "approve" | "extra">(null);

  return (
    <section className="dlvp" aria-label={it.name}>
      <header className="dlvp__head">
        <div className="grow">
          <h2>{it.name}</h2>
          <p className="subtext">
            {it.area ? `${AREA_LABEL[it.area]} · ` : ""}
            {it.revisions_enabled ? `${plural(it.included, "revisão incluída", "revisões incluídas")}${extrasApproved(it) ? ` + ${plural(extrasApproved(it), "adicional", "adicionais")}` : ""}` : it.project_service_id ? "Sem rodadas de revisão" : "Documentos gerais do projeto"}
            {!client && it.creation_responsible ? ` · Criação: ${it.creation_responsible.name}` : ""}
          </p>
        </div>
        <Badge tone={STATUS_TONE[it.status]} dot>{statusLabel(it, client)}</Badge>
      </header>

      {it.revisions_enabled && <PhaseTrack it={it} />}

      {/* Cliente: decisão sobre a versão atual */}
      {client && it.status === "awaiting_client" && (
        <ClientDecision it={it} onApprove={() => setModal("approve")} onRevision={() => setModal("revision")} />
      )}
      {client && it.status === "revision_requested" && it.open_request && (
        <div className="dlvnote">
          <Icon name="clock" size={16} />
          <div><b>A equipe está fazendo a revisão {it.open_request.round}.</b> Você será avisado quando a nova versão estiver disponível.</div>
        </div>
      )}
      {client && it.status === "detailing" && (
        <div className="dlvnote is-ok">
          <Icon name="checkCircle" size={16} />
          <div><b>Você aprovou a fase de criação{it.creation_approved_at ? ` em ${formatDate(it.creation_approved_at, true)}` : ""}.</b> Agora o projeto está no detalhamento técnico. O projeto final vai aparecer aqui.</div>
        </div>
      )}

      {/* Equipe: o que fazer agora */}
      {!client && (
        <TeamActions board={board} it={it} next={draft ? null : next} onChanged={onChanged}
          onRegisterRevision={() => setModal("revision")} onRegisterApproval={() => setModal("approve")} onExtra={() => setModal("extra")} />
      )}
      {!client && pendingExtra && <PendingExtra it={it} extraId={pendingExtra.id} onChanged={onChanged} />}
      {draft && board.can_work && <DraftEditor board={board} it={it} v={draft} people={people} onChanged={onChanged} />}

      {current ? <CurrentVersion it={it} v={current} client={client} /> : !draft && (
        <Card><EmptyState compact icon="folder" title={client ? "Ainda não há entregas neste serviço." : "Nada publicado ainda."}
          text={client ? "Quando a equipe publicar a apresentação, ela aparece aqui e você é avisado." : next ? `Use “${next.label}” para começar.` : undefined} /></Card>
      )}

      <History it={it} client={client} currentId={current?.id ?? null} />

      {modal === "revision" && it.project_service_id && (
        <RevisionModal board={board} it={it} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />
      )}
      {modal === "approve" && it.project_service_id && (
        <ApproveModal board={board} it={it} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />
      )}
      {modal === "extra" && it.project_service_id && (
        <ExtraModal board={board} it={it} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />
      )}
    </section>
  );
}

/* ---------- Trilha: apresentação → revisões → aprovação → detalhamento → final ---------- */
function PhaseTrack({ it }: { it: DeliveryItem }) {
  const presented = it.versions.some((v) => !v.is_draft && v.kind === "presentation");
  const approved = !!it.creation_approved_at;
  const final = it.status === "final";
  const answered = new Set(it.requests.filter((r) => r.answered_at).map((r) => r.round));
  const slots = Array.from({ length: Math.max(it.allowed, it.used) }, (_, i) => i + 1);
  return (
    <div className="dlvtrack" role="group" aria-label={`Revisões: ${it.used} de ${it.allowed} usadas`}>
      <div className="dlvtrack__phase">
        <span className="label">Criação</span>
        <ol className="dlvtrack__steps">
          <li className={cx("dlvstep", presented && "is-done")}><span className="dlvstep__dot">{presented ? <Icon name="check" size={12} /> : "0"}</span>Apresentação</li>
          {slots.map((n) => {
            const used = n <= it.used;
            const open = it.open_request?.round === n;
            return (
              <li key={n} className={cx("dlvstep", used && answered.has(n) && "is-done", open && "is-now", n > it.included && "is-extra")}
                title={n > it.included ? "Revisão adicional" : undefined}>
                <span className="dlvstep__dot">{used && answered.has(n) ? <Icon name="check" size={12} /> : n}</span>
                Revisão {n}{n > it.included ? <small>adicional</small> : null}
              </li>
            );
          })}
        </ol>
        <span className="dlvtrack__count">
          {it.used === 0 ? `${plural(it.allowed, "revisão disponível", "revisões disponíveis")}` : `${it.used} de ${it.allowed} usadas`}
          {!approved && remaining(it) > 0 && it.used > 0 ? ` · ${plural(remaining(it), "restante", "restantes")}` : ""}
        </span>
      </div>
      <Icon name="chevronRight" size={16} className="icon dlvtrack__arrow" />
      <div className="dlvtrack__phase dlvtrack__phase--end">
        <span className="label">Detalhamento</span>
        <ol className="dlvtrack__steps">
          <li className={cx("dlvstep", approved && "is-done")}><span className="dlvstep__dot">{approved ? <Icon name="check" size={12} /> : ""}</span>Aprovação</li>
          <li className={cx("dlvstep", final && "is-done", approved && !final && "is-now")}><span className="dlvstep__dot">{final ? <Icon name="check" size={12} /> : ""}</span>Projeto final</li>
        </ol>
      </div>
    </div>
  );
}

/* ---------- Cliente: aprovar ou pedir revisão ---------- */
function ClientDecision({ it, onApprove, onRevision }: { it: DeliveryItem; onApprove: () => void; onRevision: () => void }) {
  const left = remaining(it);
  const last = it.versions.find((v) => v.id === it.last_creation_version_id);
  return (
    <div className="dlvask">
      <div className="dlvask__text">
        <h3>{last ? `${last.kind === "revision" ? `A revisão ${last.round}` : "A apresentação preliminar"} está pronta para você avaliar` : "Avalie a versão atual"}</h3>
        <p>{left > 0
          ? <>Se estiver tudo certo, aprove para seguirmos ao detalhamento técnico. Se quiser mudanças, peça uma revisão: você tem <b>{plural(left, "revisão restante", "revisões restantes")}</b> de {it.allowed}.</>
          : <>Você já usou as <b>{plural(it.allowed, "revisão incluída", "revisões incluídas")}</b>. Aprove para seguirmos ao detalhamento. Para uma revisão adicional, <Link to="/ajuda" className="link">fale com a equipe</Link>.</>}</p>
      </div>
      <div className="dlvask__actions">
        <Button variant="outline" icon="edit" disabled={left === 0} onClick={onRevision}>Pedir revisão</Button>
        <Button icon="check" onClick={onApprove}>Aprovar projeto</Button>
      </div>
    </div>
  );
}

/* ---------- Equipe: próxima ação ---------- */
function TeamActions({ board, it, next, onChanged, onRegisterRevision, onRegisterApproval, onExtra }: {
  board: DeliveryBoard; it: DeliveryItem; next: ReturnType<typeof nextKind>; onChanged: () => void;
  onRegisterRevision: () => void; onRegisterApproval: () => void; onExtra: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const waiting = it.status === "awaiting_client";
  const canExtra = board.can_request_extra && it.revisions_enabled && it.project_service_id && !it.extras.some((e) => e.status === "pending");
  if (!next && !waiting && !canExtra) return null;

  async function start() {
    if (!next) return;
    setBusy(true);
    try { await api.deliveryVersionStart(board.project.id, it.project_service_id, next.kind, null, null, null); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <div className={cx("dlvteam", waiting && "is-waiting")}>
      {waiting ? (
        <p><Icon name="clock" size={15} /> Aguardando o cliente aprovar ou pedir revisão {it.open_request ? "" : `(${it.used} de ${it.allowed} usadas)`}.
          {board.can_work && " Se ele respondeu por WhatsApp ou reunião, registre aqui."}</p>
      ) : it.status === "revision_requested" && it.open_request ? (
        <div className="dlvreq">
          <span className="dlvreq__title"><Icon name="edit" size={15} /> Alterações pedidas na revisão {it.open_request.round}
            <small>{it.open_request.requested_by}{it.open_request.on_behalf ? " (registrada pela equipe)" : ""} · {formatDate(it.open_request.created_at)}</small></span>
          <ol>{it.open_request.items.map((x, i) => <li key={i}>{x}</li>)}</ol>
          {it.open_request.notes && <p className="dlvh__quote">{it.open_request.notes}</p>}
        </div>
      ) : <p className="grow" />}
      <div className="dlvteam__actions">
        {waiting && board.can_work && remaining(it) > 0 && <Button size="sm" variant="ghost" icon="edit" onClick={onRegisterRevision}>Registrar pedido de revisão</Button>}
        {waiting && board.can_work && <Button size="sm" variant="ghost" icon="check" onClick={onRegisterApproval}>Registrar aprovação</Button>}
        {canExtra && <Button size="sm" variant="ghost" icon="plus" onClick={onExtra}>Revisão adicional</Button>}
        {next && <Button size="sm" icon="plus" loading={busy} onClick={start}>{next.label}</Button>}
      </div>
    </div>
  );
}

function PendingExtra({ it, extraId, onChanged }: { it: DeliveryItem; extraId: string; onChanged: () => void }) {
  const toast = useToast();
  const e = it.extras.find((x) => x.id === extraId)!;
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  async function decide(approve: boolean) {
    setBusy(true);
    try { await api.deliveryExtraDecide(e.id, approve, note); toast(approve ? "Revisão adicional liberada. O cliente foi avisado." : "Pedido recusado."); onChanged(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <div className="dlvextra">
      <Icon name="alert" size={16} />
      <div className="grow">
        <b>Revisão adicional {e.kind === "courtesy" ? "como cortesia" : "paga"} aguardando a liderança</b>
        <span className="subtext">{e.requested_by} · {formatDateTime(e.created_at)}{e.amount != null ? ` · R$ ${e.amount.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : ""}</span>
        {e.reason && <p>{e.reason}</p>}
        {rejecting && <textarea className="input textarea" rows={2} placeholder="Por que não será liberada?" value={note} autoFocus onChange={(x) => setNote(x.target.value)} />}
      </div>
      {it.can_decide_extra && (
        <div className="dlvextra__actions">
          {rejecting ? <>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>Cancelar</Button>
            <Button size="sm" variant="danger" loading={busy} disabled={note.trim().length < 3} onClick={() => decide(false)}>Recusar</Button>
          </> : <>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(true)}>Recusar</Button>
            <Button size="sm" icon="check" loading={busy} onClick={() => decide(true)}>Liberar</Button>
          </>}
        </div>
      )}
    </div>
  );
}

/* ---------- Versão em preparação (equipe) ---------- */
function DraftEditor({ board, it, v, people, onChanged }: { board: DeliveryBoard; it: DeliveryItem; v: DeliveryVersion; people: Person[]; onChanged: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(v.title);
  const [notes, setNotes] = useState(v.notes ?? "");
  const [resp, setResp] = useState(v.responsible?.id ?? "");
  const [link, setLink] = useState({ name: "", url: "" });
  const [uploading, setUploading] = useState<string[]>([]);
  const [busy, setBusy] = useState<"publish" | "link" | "discard" | null>(null);
  const [discard, setDiscard] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const options = useMemo(() => {
    const m = new Map(people.map((p) => [p.id, p.name]));
    if (v.responsible) m.set(v.responsible.id, v.responsible.name);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [people, v.responsible]);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setUploading(list.map((f) => f.name));
    let ok = 0;
    for (const f of list) {
      try { await api.deliveryUpload(board.project.id, v.id, f); ok++; }
      catch (e) { toast((e as Error).message, "error"); }
    }
    setUploading([]);
    if (ok) { toast(ok === 1 ? "Arquivo anexado." : `${ok} arquivos anexados.`); onChanged(); }
  }
  async function addLink() {
    setBusy("link");
    try { await api.deliveryAddLink(v.id, link.name, link.url); setLink({ name: "", url: "" }); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function remove(f: DeliveryFile) {
    try { await api.deliveryFileRemove(f.id); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
  }
  async function publish() {
    setBusy("publish");
    try {
      await api.deliveryVersionUpdate(v.id, title, notes, v.kind === "document" ? null : resp || null);
      await api.deliveryVersionPublish(v.id);
      toast(board.is_staff ? "Publicado. O cliente foi avisado." : "Publicado.");
      onChanged();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function doDiscard() {
    setBusy("discard");
    try { await api.deliveryVersionDiscard(v.id); setDiscard(false); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }

  return (
    <Card className="dlvdraft" title={`Preparando: ${v.title}`} action={<Badge tone="warning">Rascunho · só a equipe vê</Badge>}>
      <div className="dlvdraft__grid">
        <label className="field">
          <span className="field__label">Título</span>
          <Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {v.kind !== "document" && (
          <label className="field">
            <span className="field__label">Responsável pela versão</span>
            <Select value={resp} onChange={(e) => setResp(e.target.value)}>
              <option value="">Sem responsável</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <span className="field__hint">As revisões pedidas sobre esta versão contam para esta pessoa.</span>
          </label>
        )}
        <label className="field dlvdraft__full">
          <span className="field__label">Mensagem para o cliente <small>(opcional)</small></span>
          <textarea className="input textarea" rows={2} maxLength={2000} value={notes} placeholder="Ex.: Ajustamos a suíte e a fachada conforme pedido."
            onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      <div className={cx("dlvdrop", drag && "is-drag")}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}>
        <Icon name="paperclip" size={18} />
        <span>Arraste os arquivos aqui ou <button type="button" className="link" onClick={() => input.current?.click()}>escolha no computador</button>.
          <small> PDF, imagens, DWG e outros até 50 MB. Arquivos maiores: adicione o link do Drive.</small></span>
        <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
      </div>
      {uploading.length > 0 && <p className="subtext dlvdraft__up"><span className="spinner" aria-hidden="true" /> Enviando {uploading.join(", ")}…</p>}

      {v.files.length > 0 && (
        <ul className="dlvfiles">
          {v.files.map((f) => (
            <li key={f.id}>
              <FileChip f={f} />
              <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => remove(f)}>Remover {f.name}</Button>
            </li>
          ))}
        </ul>
      )}

      <form className="dlvlink" onSubmit={(e) => { e.preventDefault(); void addLink(); }}>
        <Input aria-label="Nome do link" placeholder="Nome (ex.: Pasta no Drive, Vídeo 3D)" value={link.name} maxLength={200} onChange={(e) => setLink({ ...link, name: e.target.value })} />
        <Input aria-label="Endereço do link" placeholder="https://drive.google.com/…" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
        <Button type="submit" size="sm" variant="outline" icon="plus" loading={busy === "link"} disabled={!/^https?:\/\/\S+$/i.test(link.url.trim())}>Adicionar link</Button>
      </form>

      <div className="dlvdraft__foot">
        <Button variant="ghost" onClick={() => setDiscard(true)}>Descartar</Button>
        <Button icon="check" loading={busy === "publish"} disabled={v.files.length === 0 || title.trim().length < 2 || uploading.length > 0} onClick={publish}>
          {it.project_service_id ? "Publicar para o cliente" : "Publicar documentos"}</Button>
      </div>
      <ConfirmDialog open={discard} danger title="Descartar esta versão?" message="Os arquivos anexados nela deixam de aparecer. Nada foi enviado ao cliente."
        confirmLabel="Descartar" loading={busy === "discard"} onCancel={() => setDiscard(false)} onConfirm={doDiscard} />
    </Card>
  );
}

/* ---------- Versão atual em destaque ---------- */
function CurrentVersion({ it, v, client }: { it: DeliveryItem; v: DeliveryVersion; client: boolean }) {
  const isFinal = v.kind === "final" || v.kind === "document";
  const label = !it.revisions_enabled ? (it.project_service_id ? "Entrega mais recente" : "Documentos mais recentes")
    : isFinal ? "Projeto final" : it.creation_approved_at ? "Versão aprovada" : "Versão atual";
  return (
    <Card as="article" className={cx("dlvcur", isFinal && "is-final")}>
      <div className="dlvcur__head">
        <span className={cx("dlvcur__tag", isFinal && "is-final")}><Icon name={isFinal ? "seal" : "layers"} size={14} /> {label}</span>
        <Badge tag>{versionBadge(v)}</Badge>
        <span className="subtext">publicada em {formatDateTime(v.published_at)}{v.published_by ? ` por ${v.published_by}` : ""}</span>
      </div>
      <h3 className="dlvcur__title">{v.title}</h3>
      {v.notes && <p className="dlvcur__notes">{v.notes}</p>}
      {!client && v.responsible && <p className="subtext">Responsável: {v.responsible.name}</p>}
      <ul className="dlvfiles dlvfiles--big">{v.files.map((f) => <li key={f.id}><FileChip f={f} big /></li>)}</ul>
    </Card>
  );
}

function FileChip({ f, big }: { f: DeliveryFile; big?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function open() {
    if (f.kind === "link" && f.url) { window.open(f.url, "_blank", "noopener"); return; }
    if (!f.path) return;
    setBusy(true);
    const w = window.open("", "_blank");
    try { const url = await api.deliveryFileUrl(f.path); if (w) { w.opener = null; w.location.href = url; } else window.location.href = url; }
    catch (e) { w?.close(); toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  const ext = f.kind === "link" ? "Link" : (f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase();
  return (
    <button type="button" className={cx("dlvfile", big && "is-big")} disabled={busy} onClick={open} title={`Abrir ${f.name}`}>
      <span className={cx("dlvfile__ext", f.kind === "link" && "is-link")}>{f.kind === "link" ? <Icon name="chevronRight" size={14} /> : ext || "ARQ"}</span>
      <span className="dlvfile__name">{f.name}</span>
      <span className="dlvfile__meta">{f.kind === "link" ? new URL(f.url ?? "https://x").hostname.replace(/^www\./, "") : fmtSize(f.size)}</span>
    </button>
  );
}

/* ---------- Histórico ---------- */
type Ev = { at: string; key: string; node: ReactNode };
function History({ it, client, currentId }: { it: DeliveryItem; client: boolean; currentId: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const events: Ev[] = [];
  it.versions.filter((v) => !v.is_draft).forEach((v) => events.push({
    at: v.published_at!, key: `v${v.id}`, node: (
      <>
        <span className={cx("dlvh__icon", (v.kind === "final" || v.kind === "document") && "is-final")}><Icon name={v.kind === "final" ? "seal" : "layers"} size={14} /></span>
        <div className="grow">
          <div className="dlvh__line">
            <b>{v.title}</b> publicada{v.published_by ? ` por ${v.published_by}` : ""}
            {v.id === currentId ? <Badge tone="success">Atual</Badge>
              : v.id === it.last_creation_version_id && it.creation_approved_at ? <Badge tone="success">Aprovada</Badge>
              : (v.kind === "presentation" || v.kind === "revision") && <Badge>Substituída</Badge>}
          </div>
          <button type="button" className="link dlvh__toggle" onClick={() => setOpen(open === v.id ? null : v.id)}>
            {open === v.id ? "Ocultar arquivos" : plural(v.files.length, "arquivo", "arquivos")}
          </button>
          {open === v.id && <ul className="dlvfiles">{v.files.map((f) => <li key={f.id}><FileChip f={f} /></li>)}</ul>}
        </div>
      </>) }));
  it.requests.forEach((r) => events.push({ at: r.created_at, key: `r${r.id}`, node: <RequestEvent r={r} client={client} included={it.included} /> }));
  if (it.creation_approved_at) events.push({ at: it.creation_approved_at, key: "appr", node: (
    <>
      <span className="dlvh__icon is-ok"><Icon name="checkCircle" size={14} /></span>
      <div className="grow">
        <div className="dlvh__line"><b>Fase de criação aprovada</b>{it.creation_approved_by ? ` por ${it.creation_approved_by}` : ""}{it.approval_on_behalf ? " (registrada pela equipe)" : ""}</div>
        {it.approval_note && <p className="dlvh__quote">“{it.approval_note}”</p>}
      </div>
    </>) });
  it.extras.filter((e) => e.status !== "pending").forEach((e) => events.push({ at: e.decided_at ?? e.created_at, key: `e${e.id}`, node: (
    <>
      <span className={cx("dlvh__icon", e.status === "rejected" && "is-bad")}><Icon name="plus" size={14} /></span>
      <div className="grow">
        <div className="dlvh__line"><b>Revisão adicional {e.status === "approved" ? "liberada" : "não liberada"}</b>
          {!client && <> · {e.kind === "courtesy" ? "cortesia" : "paga"}{e.decided_by ? ` · ${e.decided_by}` : ""}</>}</div>
        {!client && e.reason && <p className="dlvh__quote">{e.reason}{e.decision_note ? ` — ${e.decision_note}` : ""}</p>}
      </div>
    </>) }));
  if (events.length === 0) return null;
  events.sort((a, b) => b.at.localeCompare(a.at));
  return (
    <Card title="Histórico" flush>
      <ol className="dlvh">
        {events.map((e) => <li key={e.key}><span className="dlvh__when">{formatDate(e.at)}</span>{e.node}</li>)}
      </ol>
    </Card>
  );
}

function RequestEvent({ r, client, included }: { r: DeliveryRequest; client: boolean; included: number }) {
  return (
    <>
      <span className="dlvh__icon is-req"><Icon name="edit" size={14} /></span>
      <div className="grow">
        <div className="dlvh__line">
          <b>Revisão {r.round} solicitada</b>{r.requested_by ? ` por ${r.requested_by}` : ""}{r.on_behalf ? " (registrada pela equipe)" : ""}
          {r.round > included && <Badge>Adicional</Badge>}
          {!r.answered_at && <Badge tone="brand">Em produção</Badge>}
        </div>
        <ul className="dlvh__items">{r.items.map((x, i) => <li key={i}>{x}</li>)}</ul>
        {r.notes && <p className="dlvh__quote">{r.notes}</p>}
        {!client && r.responsible && <span className="subtext">Conta para {r.responsible.name}</span>}
      </div>
    </>
  );
}

/* ---------- Modais ---------- */
function RevisionModal({ board, it, onClose, onDone }: { board: DeliveryBoard; it: DeliveryItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [items, setItems] = useState<string[]>([""]);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const round = it.used + 1;
  const filled = items.filter((x) => x.trim()).length;
  const set = (i: number, v: string) => setItems((xs) => xs.map((x, j) => (j === i ? v : x)));
  async function send() {
    setBusy(true);
    try {
      await api.deliveryRequestRevision(board.project.id, it.project_service_id!, items, notes);
      toast(board.is_client ? "Pedido enviado. A equipe já foi avisada." : "Pedido de revisão registrado.");
      onDone();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} wide title={`${board.is_client ? "Pedir" : "Registrar"} revisão ${round} de ${it.allowed}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={filled === 0} onClick={send}>{board.is_client ? "Enviar pedido de revisão" : "Registrar pedido"}</Button>
      </>}>
      <div className="stack">
        <div className="dlvnote">
          <Icon name="alertCircle" size={16} />
          <div>{round < it.allowed
            ? <>Esta é a revisão <b>{round} de {it.allowed}</b>. Depois dela restam {plural(it.allowed - round, "revisão", "revisões")}.</>
            : <>Esta é a <b>última revisão incluída</b> ({round} de {it.allowed}). Revisões depois desta são cobradas à parte.</>}
            {" "}Liste todas as alterações de uma vez: elas valem como uma rodada só.</div>
        </div>
        <ol className="dlvitems">
          {items.map((x, i) => (
            <li key={i}>
              <textarea className="input textarea" rows={2} maxLength={1000} value={x} autoFocus={i === items.length - 1}
                aria-label={`Alteração ${i + 1}`} placeholder={i === 0 ? "Ex.: Aumentar a suíte principal em 1 metro" : "Outra alteração"} onChange={(e) => set(i, e.target.value)} />
              {items.length > 1 && <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>Remover alteração {i + 1}</Button>}
            </li>
          ))}
        </ol>
        {items.length < 50 && <Button size="sm" variant="outline" icon="plus" onClick={() => setItems((xs) => [...xs, ""])}>Adicionar alteração</Button>}
        <label className="field">
          <span className="field__label">Observações <small>(opcional)</small></span>
          <textarea className="input textarea" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function ApproveModal({ board, it, onClose, onDone }: { board: DeliveryBoard; it: DeliveryItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    try { await api.deliveryApprove(board.project.id, it.project_service_id!, note); toast(board.is_client ? "Projeto aprovado. Seguimos para o detalhamento!" : "Aprovação registrada."); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={board.is_client ? `Aprovar ${it.name}` : `Registrar aprovação do cliente`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={!agree} onClick={send}>{board.is_client ? "Aprovar projeto" : "Registrar aprovação"}</Button>
      </>}>
      <div className="stack">
        <p>Com a aprovação, o <b>{it.name}</b> segue para o <b>detalhamento técnico</b>. A partir daí não é possível pedir novas revisões sem custo adicional.</p>
        <label className="dlvcheck">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>{board.is_client ? "Entendi e aprovo a versão atual." : "O cliente aprovou a versão atual."}</span>
        </label>
        <label className="field">
          <span className="field__label">{board.is_client ? "Quer deixar um recado para a equipe?" : "Como o cliente aprovou?"} <small>(opcional)</small></span>
          <textarea className="input textarea" rows={2} maxLength={1000} value={note} placeholder={board.is_client ? "" : "Ex.: aprovou por WhatsApp em 09/10"} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

function ExtraModal({ board, it, onClose, onDone }: { board: DeliveryBoard; it: DeliveryItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<"courtesy" | "paid">("courtesy");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const direct = !!it.can_decide_extra;
  async function send() {
    setBusy(true);
    const value = amount.trim() ? Number(amount.replace(/\./g, "").replace(",", ".")) : null;
    try {
      await api.deliveryExtraRequest(board.project.id, it.project_service_id!, kind, reason, kind === "paid" && value != null && !Number.isNaN(value) ? value : null);
      toast(direct ? "Revisão adicional liberada. O cliente foi avisado." : "Pedido enviado ao líder da área.");
      onDone();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={direct ? "Liberar revisão adicional" : "Pedir revisão adicional"}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={reason.trim().length < 5} onClick={send}>{direct ? "Liberar revisão" : "Enviar para a liderança"}</Button>
      </>}>
      <div className="stack">
        <p className="subtext">{it.name}: {it.used} de {it.allowed} revisões usadas{it.creation_approved_at ? " · criação já aprovada (será reaberta)" : ""}.
          {direct ? " Como líder da área, a liberação vale na hora." : " O líder da área recebe o pedido para aprovar."}</p>
        <Segmented<"courtesy" | "paid"> label="Tipo" value={kind} onChange={setKind} options={[{ value: "courtesy", label: "Cortesia (sem custo)" }, { value: "paid", label: "Paga pelo cliente" }]} />
        <label className="field">
          <span className="field__label">Motivo</span>
          <textarea className="input textarea" rows={3} maxLength={1000} value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
            placeholder={kind === "courtesy" ? "Ex.: ajuste pequeno na cozinha para evitar desgaste com o cliente" : "Ex.: cliente contratou revisão adicional da fachada"} />
        </label>
        {kind === "paid" && (
          <label className="field">
            <span className="field__label">Valor cobrado <small>(opcional)</small></span>
            <Input inputMode="decimal" placeholder="R$ 0,00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))} />
          </label>
        )}
      </div>
    </Modal>
  );
}

/* ---------- Resumo no detalhe do projeto (equipe) ---------- */
export function ProjectDeliveriesCard({ projectId }: { projectId: string }) {
  const q = useAsync(() => api.projectDeliveries(projectId), [projectId]);
  const b = q.data;
  return (
    <Card title="Entregas e revisões" flush action={<Link to={`/projetos/${projectId}/entregas`} className="link">Abrir entregas</Link>}>
      {!b ? <div className="settings__pad"><Skeleton height={80} radius={10} /></div> : (
        <ul className="dlvsum">
          {b.items.map((it) => (
            <li key={it.key}>
              <Link to={`/projetos/${projectId}/entregas?servico=${it.key}`} className="dlvsum__row">
                <span className="grow dlvsum__name">{it.name}</span>
                {it.revisions_enabled && <span className={cx("dlvsum__rounds num", it.used >= it.allowed && it.used > 0 && "is-full")} title="Revisões usadas">{it.used}/{it.allowed}</span>}
                <Badge tone={STATUS_TONE[it.status]} dot>{statusLabel(it, false)}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
