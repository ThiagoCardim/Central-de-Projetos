import { useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Badge, Button, Card, Input } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate, plural } from "@/utils/format";
import { todayISO } from "@/pages/schedule/model";
import type { ClientWait } from "@/types/domain";

/* ==========================================================================
   Prazo de retorno do cliente: o que a equipe aguarda, até quando, e quanto o
   cronograma já andou por falta de retorno.
   ========================================================================== */
const dm = (iso: string) => formatDate(iso);

export function waitStateText(w: ClientWait, client = false): string {
  if (w.state === "closed") {
    return w.returned_on ? `Retorno em ${dm(w.returned_on)}` : "Encerrada";
  }
  if (w.state === "late") {
    return w.late_days > 0 ? `Prazo era ${dm(w.due_on)} · cronograma +${plural(w.late_days, "dia útil", "dias úteis")}` : `Prazo venceu em ${dm(w.due_on)}`;
  }
  return client ? `Responda até ${dm(w.due_on)}` : `Prazo do cliente até ${dm(w.due_on)}`;
}

/** Equipe: esperas do projeto com "Cliente retornou" e "Abonar dias". Some quando não há nada. */
export function ClientWaitsCard({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const q = useAsync(() => api.projectClientWaits(projectId), [projectId]);
  const [returning, setReturning] = useState<ClientWait | null>(null);
  const [waiving, setWaiving] = useState<ClientWait | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const d = q.data;
  if (!d || (!d.waits.length && !d.total_late_days)) return null;
  const open = d.waits.filter((w) => w.state !== "closed");
  const closed = d.waits.filter((w) => w.state === "closed");
  const done = () => { setReturning(null); setWaiving(null); void q.reload(); onChanged?.(); };

  return (
    <Card className={cx("cwait", open.some((w) => w.state === "late") && "is-late")} title="Retorno do cliente"
      count={open.length || undefined}
      action={d.total_late_days > 0
        ? <Badge tone="warning">+{plural(d.total_late_days, "dia útil", "dias úteis")} por falta de retorno</Badge>
        : <span className="subtext">Prazo: {plural(d.days, "dia útil", "dias úteis")}</span>}>
      {open.length === 0 && <p className="subtext">Nada aguardando o cliente agora.</p>}
      <ul className="cwait__list">
        {open.map((w) => (
          <li key={w.id} className={cx("cwait__item", `is-${w.state}`)}>
            <span className="cwait__icon" aria-hidden="true"><Icon name={w.state === "late" ? "alert" : "clock"} size={16} /></span>
            <div className="grow">
              <b>{w.label}</b>
              <span className="cwait__meta">
                Aguardando desde {dm(w.started_on)} · {waitStateText(w)}
                {w.waived_until ? ` · abonado até ${dm(w.waived_until)}` : ""}
              </span>
            </div>
            <div className="cwait__actions">
              {w.can_waive && w.state === "late" && <Button size="sm" variant="ghost" onClick={() => setWaiving(w)}>Abonar dias</Button>}
              {w.can_return && <Button size="sm" icon="check" onClick={() => setReturning(w)}>Cliente retornou</Button>}
              {w.source === "documents" && <Link to={`/projetos/${projectId}/documentos`} className="btn btn--secondary btn--sm">Ver documentos</Link>}
            </div>
          </li>
        ))}
      </ul>
      {closed.length > 0 && (
        <>
          <button type="button" className="link cwait__toggle" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? "Ocultar retornos registrados" : `Ver ${plural(closed.length, "retorno registrado", "retornos registrados")}`}
          </button>
          {showClosed && (
            <ul className="cwait__list is-closed">
              {closed.map((w) => (
                <li key={w.id} className="cwait__item is-closed">
                  <span className="cwait__icon" aria-hidden="true"><Icon name="checkCircle" size={16} /></span>
                  <div className="grow">
                    <b>{w.label}</b>
                    <span className="cwait__meta">
                      {dm(w.started_on)} → {w.returned_on ? dm(w.returned_on) : "—"}
                      {w.close_source === "portal" ? " · pelo portal" : w.returned_by ? ` · registrado por ${w.returned_by}` : ""}
                      {w.late_days > 0 ? ` · +${plural(w.late_days, "dia útil", "dias úteis")}` : " · no prazo"}
                      {w.returned_note ? ` · ${w.returned_note}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {returning && <ReturnModal w={returning} onClose={() => setReturning(null)} onDone={done} />}
      {waiving && <WaiveModal w={waiving} onClose={() => setWaiving(null)} onDone={done} />}
    </Card>
  );
}

function ReturnModal({ w, onClose, onDone }: { w: ClientWait; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const today = todayISO();
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const invalid = !date || date > today || date < w.started_on;
  async function save() {
    setBusy(true);
    try {
      const r = await api.clientWaitReturn(w.id, date, note);
      toast(r.refunded_days ? `Retorno registrado. ${plural(r.refunded_days, "dia voltou", "dias voltaram")} para o cronograma.` : "Retorno registrado.");
      onDone();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Cliente retornou"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={invalid} onClick={save}>Registrar retorno</Button>
      </>}>
      <div className="stack">
        <p className="subtext">{w.label} · aguardando desde {dm(w.started_on)}, prazo {dm(w.due_on)}.</p>
        <label className="field">
          <span className="field__label">Quando o cliente retornou?</span>
          <Input type="date" value={date} min={w.started_on} max={today} onChange={(e) => setDate(e.target.value)} />
          <span className="field__hint">Se ele respondeu antes (por WhatsApp, e-mail ou reunião), informe a data real: os dias empurrados a mais voltam para o cronograma.</span>
        </label>
        <label className="field">
          <span className="field__label">Como foi o retorno? <small>(opcional)</small></span>
          <textarea className="input textarea" rows={2} maxLength={1000} value={note} placeholder="Ex.: aprovou por WhatsApp; enviou os documentos por e-mail" onChange={(e) => setNote(e.target.value)} />
        </label>
        {w.source === "delivery" && (
          <p className="dlvnote"><Icon name="alertCircle" size={16} /><span>Isto só para o relógio. Se o cliente aprovou ou pediu alterações, registre também em <b>Entregas</b>.</span></p>
        )}
        {w.source === "task" && <p className="subtext">A etapa volta para “Em andamento”.</p>}
      </div>
    </Modal>
  );
}

function WaiveModal({ w, onClose, onDone }: { w: ClientWait; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [until, setUntil] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const r = await api.clientWaitWaive(w.id, until, reason);
      toast(r.refunded_days ? `Abono registrado. ${plural(r.refunded_days, "dia voltou", "dias voltaram")} para o cronograma.` : "Abono registrado.");
      onDone();
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title="Abonar dias de atraso do cliente"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={reason.trim().length < 5 || !until || until <= w.due_on} onClick={save}>Abonar</Button>
      </>}>
      <div className="stack">
        <p className="subtext">{w.label} · prazo {dm(w.due_on)}{w.late_days ? ` · cronograma +${plural(w.late_days, "dia útil", "dias úteis")}` : ""}.</p>
        <label className="field">
          <span className="field__label">Não contar atraso até</span>
          <Input type="date" value={until} min={w.due_on} onChange={(e) => setUntil(e.target.value)} />
          <span className="field__hint">Os dias até esta data não empurram o cronograma (e os já empurrados voltam). Pode ser uma data futura, como o fim de uma viagem combinada.</span>
        </label>
        <label className="field">
          <span className="field__label">Motivo</span>
          <textarea className="input textarea" rows={2} maxLength={500} value={reason} autoFocus placeholder="Ex.: cliente viajando, combinado por telefone" onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

/** Cliente: o que estamos aguardando dele. */
export function ClientWaitBanner() {
  const q = useAsync(() => api.myClientWaits(), []);
  const list = q.data ?? [];
  if (list.length === 0) return null;
  const late = list.some((w) => w.state === "late");
  return (
    <Card className={cx("cwaitc", late && "is-late")}>
      <span className="cwaitc__icon" aria-hidden="true"><Icon name={late ? "alert" : "clock"} /></span>
      <div className="grow">
        <h2>{list.length === 1 ? "Aguardamos o seu retorno" : `Aguardamos o seu retorno em ${list.length} itens`}</h2>
        <ul className="cwaitc__list">
          {list.map((w) => (
            <li key={w.id}>
              <span><b>{w.label}</b>{list.some((x) => x.project_id !== w.project_id) && w.project_name ? ` · ${w.project_name}` : ""}</span>
              <span className={cx("cwaitc__due", w.state === "late" && "is-late")}>{waitStateText(w, true)}</span>
            </li>
          ))}
        </ul>
        <p className="cwaitc__hint">{late
          ? "Como o prazo passou, as próximas etapas foram adiadas. Assim que você responder, o projeto volta a andar."
          : "Seu retorno no prazo mantém o cronograma em dia. Se precisar de ajuda, fale com a equipe."}</p>
      </div>
      <div className="cwaitc__actions">
        {list.some((w) => w.source === "documents") && <Link to={`/documentos?projeto=${list.find((w) => w.source === "documents")!.project_id}`} className="btn btn--primary">Enviar documentos</Link>}
        {list.some((w) => w.source === "delivery") && <Link to={`/entregas?projeto=${list.find((w) => w.source === "delivery")!.project_id}`} className={list.some((w) => w.source === "documents") ? "btn btn--secondary" : "btn btn--primary"}>Ver entregas</Link>}
        <Link to="/ajuda" className="btn btn--secondary"><Icon name="chat" /> Falar com a equipe</Link>
      </div>
    </Card>
  );
}

/** CS e gestão: esperas abertas nos projetos. */
export function ClientWaitsOverviewCard() {
  const q = useAsync(() => api.clientWaitsOverview(), []);
  const list = (q.data ?? []).slice().sort((a, b) => (b.state === "late" ? 1 : 0) - (a.state === "late" ? 1 : 0) || b.late_days - a.late_days);
  if (!q.data) return null;
  const late = list.filter((w) => w.state === "late").length;
  return (
    <Card title="Aguardando retorno do cliente" count={list.length || undefined} flush
      action={late ? <Badge tone="warning">{plural(late, "atrasado", "atrasados")}</Badge> : undefined}>
      {list.length === 0 ? <p className="subtext settings__pad">Nenhum projeto aguardando o cliente.</p> : (
        <ul className="cwait__list cwait__list--flush">
          {list.map((w) => (
            <li key={w.id} className={cx("cwait__item", `is-${w.state}`)}>
              <span className="cwait__icon" aria-hidden="true"><Icon name={w.state === "late" ? "alert" : "clock"} size={16} /></span>
              <Link to={`/projetos/${w.project_id}`} className="grow cwait__link">
                <span><b>{w.project_name}</b>{w.client_name ? ` · ${w.client_name}` : ""}</span>
                <span className="cwait__meta">{w.label} · {waitStateText(w)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
