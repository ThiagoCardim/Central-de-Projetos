import { useRef, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Badge, Button, Card, EmptyState, Input, LoadError, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate, formatDateTime, plural } from "@/utils/format";
import { fmtSize } from "@/pages/deliveries/deliveriesUi";
import type { DocFile, DocProgress, DocStatus, DocumentsBoard, ProjectDocument } from "@/types/domain";

/* ==========================================================================
   Documentos do cliente: o que o projeto precisa, o que já chegou e o que a
   equipe já conferiu. As regras de verdade estão no banco.
   ========================================================================== */
const STATUS: Record<DocStatus, { client: string; team: string; tone: "neutral" | "brand" | "success" | "danger" }> = {
  pending: { client: "Pendente", team: "Aguardando o cliente", tone: "neutral" },
  submitted: { client: "Em conferência", team: "Conferir", tone: "brand" },
  approved: { client: "Aprovado", team: "Aprovado", tone: "success" },
  rejected: { client: "Enviar novamente", team: "Reenvio pedido", tone: "danger" },
};

/** Barra de progresso em duas camadas: aprovado (cheio) e em conferência (claro). */
export function DocProgressBar({ p, label }: { p: DocProgress; label: string }) {
  const total = Math.max(1, p.total);
  const ok = (p.approved / total) * 100;
  const sent = (p.submitted / total) * 100;
  return (
    <div className="docbar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.percent ?? 0}>
      <span className="docbar__ok" style={{ width: `${ok}%` }} />
      <span className="docbar__sent" style={{ width: `${sent}%` }} />
    </div>
  );
}

function progressText(p: DocProgress, client: boolean) {
  const parts = [
    p.approved && plural(p.approved, "aprovado", "aprovados"),
    p.submitted && `${p.submitted} em conferência`,
    p.rejected && `${p.rejected} para ${client ? "reenviar" : "o cliente reenviar"}`,
    p.pending && plural(p.pending, "pendente", "pendentes"),
  ].filter(Boolean);
  return parts.join(" · ");
}

export function DocumentsView({ projectId }: { projectId: string }) {
  const q = useAsync(() => api.projectDocuments(projectId), [projectId]);
  const [adding, setAdding] = useState(false);
  const [waitOn, setWaitOn] = useState<boolean | null>(null);
  const b = q.data;
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!b) return <Skeleton height={420} radius={16} />;
  const reload = () => void q.reload();
  const client = b.is_client;
  const p = b.progress;
  const missingRequired = p.required_total - p.required_sent;

  return (
    <div className="stack docs">
      <Card className="docsum">
        <div className="docsum__top">
          <div className="docsum__pct">
            <span className="docsum__num num">{p.percent ?? 0}%</span>
            <span className="subtext">{client ? "dos seus documentos aprovados" : "dos documentos aprovados"}</span>
          </div>
          <div className="grow docsum__bar">
            <DocProgressBar p={p} label="Documentos aprovados" />
            <span className="subtext">{p.total ? progressText(p, client) : "Nenhum documento pedido."}</span>
          </div>
          {b.can_manage && <Button icon="plus" variant="secondary" onClick={() => setAdding(true)}>Pedir documento</Button>}
        </div>
        {p.required_total > 0 && (
          <p className={cx("docsum__req", missingRequired === 0 && "is-ok")}>
            <Icon name={missingRequired === 0 ? "checkCircle" : "flag"} size={16} />
            <span>
              {missingRequired === 0
                ? <><b>Obrigatórios para iniciar enviados</b> ({p.required_sent} de {p.required_total}).</>
                : <><b>Obrigatórios para iniciar: {p.required_sent} de {p.required_total} enviados.</b>{" "}
                  {client ? "Envie os que faltam para começarmos o desenvolvimento do seu projeto." : "O desenvolvimento depende deles."}</>}
              {b.wait && b.wait.state !== "closed" && (
                <span className={cx("docsum__due", b.wait.state === "late" && "is-late")}>
                  {b.wait.state === "late"
                    ? ` Prazo era ${formatDate(b.wait.due_on)}${b.wait.late_days ? `: cronograma adiado ${plural(b.wait.late_days, "dia útil", "dias úteis")}` : ""}.`
                    : ` Prazo: ${formatDate(b.wait.due_on)}.`}
                </span>
              )}
            </span>
          </p>
        )}
        {b.is_staff && (
          <p className="subtext docsum__meta">
            {b.holder === "pj" ? "Proprietário pessoa jurídica" : "Proprietário pessoa física"} (pelo CPF/CNPJ do cliente).{" "}
            {b.documents_wait === false
              ? <>Prazo automático dos obrigatórios desligado neste projeto.{b.can_manage && <> <button type="button" className="link" onClick={() => setWaitOn(true)}>Ligar prazo</button></>}</>
              : b.can_manage && <button type="button" className="link" onClick={() => setWaitOn(false)}>Desligar prazo automático</button>}
          </p>
        )}
        {b.is_client && b.can_decide === false && (
          <p className="subtext docsum__hint"><Icon name="eye" size={14} /> Seu acesso a este projeto é para acompanhar. O envio dos documentos é feito pela pessoa responsável pelo projeto.</p>
        )}
        {b.can_upload && p.total > 0 && (
          <p className="subtext docsum__hint"><Icon name="paperclip" size={14} /> PDF, foto ou outro arquivo de até 50 MB (maiores, pelo link do Drive). Também dá para arrastar o arquivo até o documento.</p>
        )}
      </Card>

      {b.items.length === 0 ? (
        <Card><EmptyState icon="file" title="Nenhum documento pedido para este projeto."
          text={b.can_manage ? "A lista padrão fica em Configurações › Documentos do cliente. Use “Pedir documento” para algo específico deste projeto." : undefined} /></Card>
      ) : (
        <>
          {(b.questions ?? []).length > 0 && <QuestionsCard b={b} onChanged={reload} />}
          {groupBySection(b.items).map((g) => (
            <section key={g.key} className="docgroup" aria-label={g.title ?? "Documentos"}>
              {g.title && <h2 className="docgroup__title">{g.title}</h2>}
              <ol className="doclist">
                {g.items.map(({ d, n }) => <DocItem key={d.id} b={b} d={d} n={n} onChanged={reload} />)}
              </ol>
            </section>
          ))}
        </>
      )}
      {b.items.length === 0 && (b.questions ?? []).length > 0 && <QuestionsCard b={b} onChanged={reload} />}

      {b.can_manage && b.removed.length > 0 && <RemovedList b={b} onChanged={reload} />}
      {adding && <ExtraModal projectId={b.project.id} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {waitOn !== null && <WaitToggle projectId={b.project.id} on={waitOn} days={b.documents_days} onClose={() => setWaitOn(null)} onDone={() => { setWaitOn(null); reload(); }} />}
    </div>
  );
}

/** Agrupa pela seção (a lista já vem na ordem); os extras ficam juntos no fim. */
function groupBySection(items: ProjectDocument[]) {
  const out: { group: string; key: string; title: string | null; items: { d: ProjectDocument; n: number }[] }[] = [];
  const anySection = items.some((d) => d.section);
  items.forEach((d, i) => {
    const key = d.source === "extra" ? "extra" : d.section ?? "";
    const title = d.source === "extra" ? "Solicitados pela equipe" : d.section ?? (anySection ? "Outros documentos" : null);
    const last = out[out.length - 1];
    if (last && last.group === key) last.items.push({ d, n: i + 1 });
    else out.push({ group: key, key: `${key}#${out.length}`, title, items: [{ d, n: i + 1 }] });
  });
  return out;
}

function QuestionsCard({ b, onChanged }: { b: DocumentsBoard; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function answer(id: string, v: boolean) {
    setBusy(id + v);
    try { await api.documentAnswer(b.project.id, id, v); toast(v ? "Resposta registrada. Os documentos relacionados entraram na lista." : "Resposta registrada."); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  return (
    <Card className="docq">
      {(b.questions ?? []).map((x) => (
        <div key={x.id} className={cx("docq__row", x.answer === null && "is-open")}>
          <Icon name="help" size={18} />
          <div className="grow">
            <b>{x.text}</b>
            <span className="subtext">
              {x.answer === null ? (b.is_client ? "Responda para sabermos quais documentos pedir." : "Aguardando a resposta do cliente (a equipe também pode responder).")
                : `Resposta: ${x.answer ? "Sim" : "Não"}${x.answered_by ? ` · ${x.answered_by}` : ""}${x.answered_at ? ` · ${formatDate(x.answered_at)}` : ""}`}
              {x.help ? ` ${x.help}` : ""}
            </span>
          </div>
          {x.can_answer && (
            <div className="segmented docq__ans" role="radiogroup" aria-label={x.text}>
              <button type="button" role="radio" aria-checked={x.answer === true} disabled={busy !== null} onClick={() => answer(x.id, true)}>Sim</button>
              <button type="button" role="radio" aria-checked={x.answer === false} disabled={busy !== null} onClick={() => answer(x.id, false)}>Não</button>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

function WaitToggle({ projectId, on, days, onClose, onDone }: { projectId: string; on: boolean; days: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.documentsWaitSet(projectId, on); toast(on ? "Prazo dos documentos ligado." : "Prazo dos documentos desligado."); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={on ? "Ligar o prazo dos documentos?" : "Desligar o prazo dos documentos?"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={save}>{on ? "Ligar prazo" : "Desligar prazo"}</Button></>}>
      <p>{on
        ? `Se faltar algum obrigatório, o cliente passa a ter ${days} dias úteis a partir de amanhã. Vencido, o cronograma do projeto é adiado a cada dia útil de atraso.`
        : "O cliente continua vendo e enviando os documentos, mas a falta deles deixa de adiar o cronograma. Dias já adiados por este prazo voltam."}</p>
    </Modal>
  );
}

function DocItem({ b, d, n, onChanged }: { b: DocumentsBoard; d: ProjectDocument; n: number; onChanged: () => void }) {
  const toast = useToast();
  const client = b.is_client;
  const st = STATUS[d.status];
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [busy, setBusy] = useState<"link" | "approve" | null>(null);
  const [modal, setModal] = useState<"reject" | "remove" | "edit" | null>(null);
  const canSend = b.can_upload && d.status !== "approved";

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length || !canSend) return;
    setUploading(list.map((f) => f.name));
    let ok = 0;
    for (const f of list) {
      try { await api.documentUpload(b.project.id, d.id, f); ok++; } catch (e) { toast((e as Error).message, "error"); }
    }
    setUploading([]);
    if (ok) { toast(client ? "Documento enviado. A equipe vai conferir." : ok === 1 ? "Arquivo anexado." : `${ok} arquivos anexados.`); onChanged(); }
  }
  async function addLink() {
    if (!link) return;
    setBusy("link");
    try { await api.documentAddLink(d.id, link.name || d.name, link.url); setLink(null); toast(client ? "Link enviado. A equipe vai conferir." : "Link anexado."); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function remove(f: DocFile) {
    try { await api.documentFileRemove(f.id); onChanged(); } catch (e) { toast((e as Error).message, "error"); }
  }
  async function approve() {
    setBusy("approve");
    try { await api.documentReview(d.id, true, null); toast("Documento aprovado."); onChanged(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }

  return (
    <li className={cx("docit", `is-${d.status}`, drag && "is-drag")}
      onDragOver={(e) => { if (canSend && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { if (!canSend) return; e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}>
      <span className="docit__n" aria-hidden="true">{d.status === "approved" ? <Icon name="check" size={14} /> : n}</span>
      <div className="docit__body">
        <div className="docit__head">
          <h3 className="docit__name">{d.name}</h3>
          {d.required ? <Badge tone="warning" outline>Obrigatório para iniciar</Badge> : <Badge outline>Opcional</Badge>}
          {d.source === "extra" && !client && d.requested_by && <Badge tag>{`Pedido por ${d.requested_by}`}</Badge>}
          <span className="grow" />
          <Badge tone={st.tone} dot>{client ? st.client : st.team}</Badge>
        </div>
        {d.description && <p className="docit__desc">{d.description}</p>}
        {d.status === "rejected" && d.reject_reason && (
          <p className="docit__reject"><Icon name="alertCircle" size={16} /><span><b>{client ? "O que precisa ser corrigido:" : "Pedido ao cliente:"}</b> {d.reject_reason}</span></p>
        )}

        {d.files.length > 0 && (
          <ul className="dlvfiles docit__files">
            {d.files.map((f) => (
              <li key={f.id}>
                <DocFileChip f={f} />
                {!client && f.on_behalf && <span className="subtext">registrado pela equipe{f.by ? ` · ${f.by}` : ""}</span>}
                {canSend && d.status !== "approved" && (!client || f.mine) && (
                  <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => remove(f)}>Remover {f.name}</Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {uploading.length > 0 && <p className="subtext"><span className="spinner" aria-hidden="true" /> Enviando {uploading.join(", ")}…</p>}

        {canSend && (
          link ? (
            <form className="dlvlink docit__link" onSubmit={(e) => { e.preventDefault(); void addLink(); }}>
              <Input aria-label="Nome do link" placeholder={`Nome (ex.: ${d.name})`} value={link.name} maxLength={200} onChange={(e) => setLink({ ...link, name: e.target.value })} />
              <Input aria-label="Endereço do link" placeholder="https://drive.google.com/…" value={link.url} autoFocus onChange={(e) => setLink({ ...link, url: e.target.value })} />
              <div className="row">
                <Button type="button" size="sm" variant="ghost" onClick={() => setLink(null)}>Cancelar</Button>
                <Button type="submit" size="sm" icon="check" loading={busy === "link"} disabled={!/^https?:\/\/\S+$/i.test(link.url.trim())}>Enviar link</Button>
              </div>
            </form>
          ) : (
            client && (
              <div className="docit__send">
                <Button size="sm" icon="paperclip" variant={d.files.length ? "ghost" : "primary"} onClick={() => input.current?.click()}>
                  {d.files.length ? "Anexar mais" : "Enviar arquivo"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setLink({ name: "", url: "" })}>Enviar por link</Button>
              </div>
            )
          )
        )}
        {canSend && <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />}

        <div className="docit__foot">
          <span className="subtext">
            {d.status === "approved" && d.reviewed_at ? `Aprovado em ${formatDate(d.reviewed_at)}${d.reviewed_by ? ` por ${d.reviewed_by}` : ""}`
              : d.submitted_at ? `Enviado em ${formatDateTime(d.submitted_at)}` : ""}
          </span>
          <span className="grow" />
          {!client && canSend && !link && (
            <>
              <Button size="sm" variant="ghost" icon="paperclip" title="Anexar um arquivo recebido do cliente" onClick={() => input.current?.click()}>Anexar pelo cliente</Button>
              <Button size="sm" variant="ghost" onClick={() => setLink({ name: "", url: "" })}>Link</Button>
            </>
          )}
          {b.can_manage && d.source === "extra" && <Button size="sm" variant="ghost" icon="edit" onClick={() => setModal("edit")}>Editar</Button>}
          {b.can_manage && <Button size="sm" variant="ghost" onClick={() => setModal("remove")}>Remover</Button>}
          {b.can_review && d.status === "approved" && <Button size="sm" variant="ghost" icon="refresh" onClick={() => setModal("reject")}>Pedir novo envio</Button>}
          {b.can_review && d.status === "submitted" && (
            <>
              <Button size="sm" variant="outline" onClick={() => setModal("reject")}>Pedir reenvio</Button>
              <Button size="sm" icon="check" loading={busy === "approve"} onClick={approve}>Aprovar</Button>
            </>
          )}
        </div>

        {d.history.length > 0 && (
          <details className="docit__hist">
            <summary>{plural(d.history.length, "arquivo de envio anterior", "arquivos de envios anteriores")}</summary>
            <ul className="dlvfiles">{d.history.map((f) => <li key={f.id}><DocFileChip f={f} /><span className="subtext">envio {f.round}</span></li>)}</ul>
          </details>
        )}
      </div>
      {modal === "reject" && <RejectModal d={d} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
      {modal === "remove" && <RemoveModal d={d} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
      {modal === "edit" && <ExtraModal projectId={b.project.id} doc={d} onClose={() => setModal(null)} onDone={() => { setModal(null); onChanged(); }} />}
    </li>
  );
}

function DocFileChip({ f }: { f: DocFile }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function open() {
    if (f.kind === "link" && f.url) { window.open(f.url, "_blank", "noopener"); return; }
    if (!f.path) return;
    setBusy(true);
    const w = window.open("", "_blank");
    try { const url = await api.documentFileUrl(f.path); if (w) { w.opener = null; w.location.href = url; } else window.location.href = url; }
    catch (e) { w?.close(); toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  const ext = (f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase();
  let host = "";
  if (f.kind === "link") { try { host = new URL(f.url ?? "").hostname.replace(/^www\./, ""); } catch { host = "link"; } }
  return (
    <button type="button" className="dlvfile" disabled={busy} onClick={open} title={`Abrir ${f.name}`}>
      <span className={cx("dlvfile__ext", f.kind === "link" && "is-link")}>{f.kind === "link" ? <Icon name="chevronRight" size={14} /> : ext || "ARQ"}</span>
      <span className="dlvfile__name">{f.name}</span>
      <span className="dlvfile__meta">{f.kind === "link" ? host : fmtSize(f.size)}</span>
    </button>
  );
}

function RemovedList({ b, onChanged }: { b: DocumentsBoard; onChanged: () => void }) {
  const toast = useToast();
  return (
    <details className="versions">
      <summary><Icon name="clock" size={16} /> Removidos deste projeto <span className="muted">· {b.removed.length}</span></summary>
      <ul className="history">
        {b.removed.map((d) => (
          <li key={d.id}>
            <span className="history__what">{d.name}{d.removed_reason ? <span className="muted"> · {d.removed_reason}</span> : null}</span>
            <span className="history__when">
              <Button size="sm" variant="ghost" icon="refresh" onClick={async () => {
                try { await api.documentRestore(d.id); toast("Documento de volta à lista do projeto."); onChanged(); }
                catch (e) { toast((e as Error).message, "error"); }
              }}>Devolver à lista</Button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function RejectModal({ d, onClose, onDone }: { d: ProjectDocument; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.documentReview(d.id, false, reason); toast("Pedido de reenvio enviado ao cliente."); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={d.status === "approved" ? `Pedir novo envio: ${d.name}` : `Pedir reenvio: ${d.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="refresh" loading={busy} disabled={reason.trim().length < 5} onClick={save}>Pedir reenvio</Button></>}>
      <div className="stack">
        <label className="field">
          <span className="field__label">O que o cliente precisa corrigir?</span>
          <textarea className="input textarea" rows={3} maxLength={1000} autoFocus value={reason}
            placeholder="Ex.: a matrícula precisa ter sido emitida nos últimos 30 dias" onChange={(e) => setReason(e.target.value)} />
          <span className="field__hint">O cliente recebe esta mensagem. O envio atual fica no histórico.</span>
        </label>
        {d.required && <p className="subtext">Como é obrigatório, o prazo de envio do cliente volta a correr.</p>}
      </div>
    </Modal>
  );
}

function RemoveModal({ d, onClose, onDone }: { d: ProjectDocument; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.documentRemove(d.id, reason); toast("Documento removido deste projeto."); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Remover “${d.name}” deste projeto?`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={save}>Remover</Button></>}>
      <div className="stack">
        <p>O cliente deixa de ver este pedido. Arquivos já enviados ficam guardados e o documento pode voltar à lista depois.</p>
        <label className="field">
          <span className="field__label">Motivo</span>
          <Input value={reason} maxLength={500} autoFocus placeholder="Ex.: a prefeitura deixou de exigir" onChange={(e) => setReason(e.target.value)} />
        </label>
        {d.source === "standard" && <p className="subtext">Remove só deste projeto. A lista padrão continua igual.</p>}
      </div>
    </Modal>
  );
}

function ExtraModal({ projectId, doc, onClose, onDone }: { projectId: string; doc?: ProjectDocument; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(doc?.name ?? "");
  const [desc, setDesc] = useState(doc?.description ?? "");
  const [required, setRequired] = useState(doc?.required ?? false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      if (doc) { await api.documentExtraUpdate(doc.id, name, desc, required); toast("Documento atualizado."); }
      else { await api.documentExtraAdd(projectId, name, desc, required); toast("Documento pedido. O cliente foi avisado."); }
      onDone();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={doc ? "Editar documento pedido" : "Pedir documento ao cliente"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={name.trim().length < 2} onClick={save}>{doc ? "Salvar" : "Pedir documento"}</Button></>}>
      <div className="stack">
        {!doc && <p className="subtext">Vale só para este projeto (ex.: exigência de um órgão na aprovação). Para pedir em todos os projetos, use a lista padrão em Configurações.</p>}
        <label className="field">
          <span className="field__label">Documento</span>
          <Input value={name} maxLength={120} autoFocus placeholder="Ex.: Certidão negativa de débitos municipais" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Orientação ao cliente <small>(opcional)</small></span>
          <textarea className="input textarea" rows={2} maxLength={1000} value={desc} placeholder="Onde conseguir, validade, formato…" onChange={(e) => setDesc(e.target.value)} />
        </label>
        <label className="pset__check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <span><b>Obrigatório</b><small>Sem ele o projeto não segue: entra no prazo de envio do cliente e, vencido, adia o cronograma.</small></span>
        </label>
      </div>
    </Modal>
  );
}

/* ---------- Resumo no detalhe do projeto (equipe) ---------- */
export function ProjectDocumentsCard({ projectId }: { projectId: string }) {
  const q = useAsync(() => api.projectDocuments(projectId), [projectId]);
  const b = q.data;
  const p = b?.progress;
  return (
    <Card title="Documentos do cliente" action={<Link to={`/projetos/${projectId}/documentos`} className="link">Abrir documentos</Link>}>
      {!b || !p ? <Skeleton height={60} radius={10} /> : p.total === 0 ? <p className="subtext">Nenhum documento pedido.</p> : (
        <div className="docmini">
          <div className="docmini__row"><b className="num">{p.percent ?? 0}%</b><span className="subtext">aprovados</span><span className="grow" />
            {p.submitted > 0 && <Badge tone="brand" dot>{p.submitted} para conferir</Badge>}</div>
          <DocProgressBar p={p} label="Documentos aprovados" />
          <span className="subtext">{progressText(p, false)}{p.required_total ? ` · obrigatórios: ${p.required_sent}/${p.required_total} enviados` : ""}</span>
        </div>
      )}
    </Card>
  );
}

/* ---------- Início do cliente ---------- */
export function ClientDocumentsCard() {
  const q = useAsync(() => api.documentProjects(), []);
  const list = (q.data ?? []).filter((x) => x.progress.total > 0 && (x.progress.percent ?? 0) < 100);
  if (list.length === 0) return null;
  return (
    <Card title="Seus documentos" action={<Link to="/documentos" className="link">Ver documentos</Link>}>
      <ul className="docmini__list">
        {list.map((x) => {
          const p = x.progress;
          const missing = p.required_total - p.required_sent;
          return (
            <li key={x.id}>
              <Link to={`/documentos?projeto=${x.id}`} className="docmini">
                <div className="docmini__row">
                  <b className="num">{p.percent ?? 0}%</b><span className="subtext">aprovados</span>
                  {list.length > 1 && <><span className="grow" /><span className="subtext">{x.name}</span></>}
                </div>
                <DocProgressBar p={p} label={`Documentos de ${x.name}`} />
                <span className={cx("subtext", missing > 0 && "text-warning")}>
                  {missing > 0 ? `Falta${missing > 1 ? "m" : ""} ${plural(missing, "documento obrigatório", "documentos obrigatórios")} para iniciarmos o projeto`
                    : p.pending + p.rejected > 0 ? `${plural(p.pending + p.rejected, "documento pendente", "documentos pendentes")}` : "Tudo enviado. A equipe está conferindo."}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

