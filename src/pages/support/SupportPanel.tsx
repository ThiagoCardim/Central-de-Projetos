import { useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link, useNavigate } from "@/lib/router";
import { Badge, Button, Card, EmptyState, LoadError, MetricCard, SearchInput, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDateTime, plural } from "@/utils/format";
import { normName } from "@/components/ui/StepPicker";
import type { SupportStatus, SupportTicket } from "@/types/domain";
import { SUPPORT_STATUS, TARGET_SHORT, timeAgo, waDigits, waLink } from "./supportUi";

/* ==========================================================================
   Atendimentos "Preciso de ajuda": o CS confirma com o cliente se resolveu
   ========================================================================== */
type Filter = "open" | "resolved" | "unresolved" | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Aguardando validação" }, { value: "unresolved", label: "Não resolvidos" },
  { value: "resolved", label: "Resolvidos" }, { value: "all", label: "Todos" },
];

export function SupportPanel({ onOpenRequest }: { onOpenRequest?: (projectId: string) => void }) {
  const q = useAsync(() => api.supportTickets(), []);
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [closing, setClosing] = useState<{ t: SupportTicket; status: SupportStatus } | null>(null);

  const rows = q.data ?? [];
  const s = normName(search);
  const base = rows.filter((r) => !s || normName(`${r.requester.name} ${r.client_name ?? ""} ${r.project_name} ${r.category} ${r.contact_name ?? ""} ${r.message ?? ""}`).includes(s));
  const list = base.filter((r) => filter === "all" || r.status === filter);
  const stats = useMemo(() => supportStats(rows), [rows]);

  return (
    <div className="supp">
      <div className="metrics">
        <MetricCard label="Aguardando validação" value={stats.open} tone={stats.open ? "warning" : "quiet"} hint="Confirme com o cliente se resolveu" onClick={() => setFilter("open")} />
        <MetricCard label="Abertos no mês" value={stats.month} hint={stats.top ? `Mais pedido: ${stats.top}` : "Nenhum no mês"} />
        <MetricCard label="Resolvidos" value={stats.resolvedPct != null ? `${stats.resolvedPct}%` : "—"} hint={stats.closed ? `${plural(stats.closed, "atendimento validado", "atendimentos validados")}` : "Nenhum validado ainda"} />
        <MetricCard label="Sem WhatsApp cadastrado" value={stats.noWhatsapp} tone={stats.noWhatsapp ? "danger" : "quiet"} hint="Cliente não foi direcionado: fale com ele" />
      </div>
      <div className="aprv__filters">
        <div className="chips" role="group" aria-label="Situação">
          {FILTERS.map((f) => {
            const n = f.value === "all" ? 0 : base.filter((r) => r.status === f.value).length;
            return (
              <button key={f.value} type="button" className="chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                {f.label}{f.value !== "resolved" && n > 0 && <span className={cx("chip__n", f.value === "unresolved" && "is-bad")}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="cs__search">
          <SearchInput aria-label="Buscar atendimento" placeholder="Cliente, projeto ou assunto" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {q.error ? <LoadError message={q.error} onRetry={() => void q.reload()} />
        : q.loading && !q.data ? <Skeleton height={300} radius={16} />
        : (
          <Card flush>
            {list.length === 0 ? (
              <EmptyState compact icon="chat" title={rows.length ? "Nenhum atendimento nesta situação." : "Nenhum pedido de ajuda ainda."}
                text={rows.length ? "Troque o filtro para ver os demais." : "Quando um cliente usar “Preciso de ajuda”, o atendimento aparece aqui para você acompanhar."} />
            ) : (
              <ul className="supl">
                {list.map((t) => <SupportRow key={t.id} t={t} onClose={(status) => setClosing({ t, status })} onOpenRequest={onOpenRequest}
                  onReopen={async () => { await api.supportTicketUpdate(t.id, "open", null); await q.reload(); }} />)}
              </ul>
            )}
          </Card>
        )}
      <CloseModal value={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); void q.reload(); }} />
    </div>
  );
}

function supportStats(rows: SupportTicket[]) {
  const now = new Date(); const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = rows.filter((r) => new Date(r.created_at).getTime() >= monthStart);
  const byCat = new Map<string, number>();
  month.forEach((r) => byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1));
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const resolved = rows.filter((r) => r.status === "resolved").length;
  const closed = resolved + rows.filter((r) => r.status === "unresolved").length;
  return {
    open: rows.filter((r) => r.status === "open").length, month: month.length, top, closed,
    resolvedPct: closed ? Math.round((100 * resolved) / closed) : null,
    noWhatsapp: rows.filter((r) => r.status === "open" && !r.has_whatsapp).length,
  };
}

function SupportRow({ t, onClose, onReopen, onOpenRequest }: {
  t: SupportTicket; onClose: (s: SupportStatus) => void; onReopen: () => Promise<void>; onOpenRequest?: (projectId: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const st = SUPPORT_STATUS[t.status];
  const phone = waDigits(t.requester.phone);
  return (
    <li className={cx("supl__item", t.status !== "open" && "is-closed")}>
      <span className={cx("supl__icon", `is-${t.target}`)} aria-hidden="true"><Icon name="chat" size={16} /></span>
      <div className="grow supl__main">
        <div className="supl__head">
          <b>{t.requester.name}</b>
          <span className="supl__cat">{t.category}</span>
          <Badge tone={st.tone} dot>{st.label}</Badge>
          <span className="subtext" title={formatDateTime(t.created_at)}>{timeAgo(t.created_at)}</span>
        </div>
        <span className="supl__meta">
          <Link to={`/projetos/${t.project_id}`} className="link">{t.project_name}</Link>{t.project_code ? ` · ${t.project_code}` : ""}
          {" · "}{t.has_whatsapp
            ? <>direcionado para <b>{t.contact_name}</b>{t.target !== "cs" && t.contact_name !== "Customer Success" ? ` (${TARGET_SHORT[t.target]})` : ""}</>
            : <span className="supl__warn"><Icon name="alert" size={12} /> sem WhatsApp cadastrado{t.contact_name ? ` para ${t.contact_name}` : ""}: cliente não foi direcionado</span>}
          {t.tenant_name ? ` · ${t.tenant_name}` : ""}
        </span>
        {t.message && <p className="supl__msg">“{t.message}”</p>}
        {t.status !== "open" && (
          <p className="supl__note"><Icon name={t.status === "resolved" ? "checkCircle" : "alertCircle"} size={13} />
            {t.status === "resolved" ? "Validado" : "Marcado como não resolvido"}{t.closed_by ? ` por ${t.closed_by.name}` : ""}{t.closed_at ? ` em ${formatDateTime(t.closed_at)}` : ""}
            {t.cs_note ? <>: <i>{t.cs_note}</i></> : ""}</p>
        )}
      </div>
      <div className="supl__actions">
        {phone && <a className="btn btn--ghost btn--sm" href={waLink(phone, `Olá, ${t.requester.name.split(" ")[0]}! Aqui é do Customer Success da YouCon. Conseguimos resolver a sua dúvida sobre ${t.category.toLowerCase()}?`)}
          target="_blank" rel="noopener noreferrer"><Icon name="chat" /> Falar com o cliente</a>}
        {t.status === "open" ? (
          <>
            <Button size="sm" variant="outline" icon="alert" onClick={() => onClose("unresolved")}>Não resolvido</Button>
            <Button size="sm" icon="check" onClick={() => onClose("resolved")}>Resolvido</Button>
          </>
        ) : (
          <>
            {t.status === "unresolved" && onOpenRequest && <Button size="sm" variant="outline" icon="headset" onClick={() => onOpenRequest(t.project_id)}>Abrir chamado</Button>}
            <Button size="sm" variant="ghost" icon="refresh" loading={busy} onClick={async () => {
              setBusy(true); try { await onReopen(); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
            }}>Reabrir</Button>
          </>
        )}
      </div>
    </li>
  );
}

function CloseModal({ value, onClose, onDone }: { value: { t: SupportTicket; status: SupportStatus } | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!value) return null;
  const ok = value.status === "resolved";
  async function save() {
    if (!value) return;
    setBusy(true);
    try { await api.supportTicketUpdate(value.t.id, value.status, note); toast(ok ? "Atendimento validado como resolvido." : "Atendimento marcado como não resolvido."); setNote(""); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={ok ? "Confirmar que foi resolvido" : "Marcar como não resolvido"}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon={ok ? "check" : "alert"} variant={ok ? "primary" : "danger"} loading={busy} disabled={!ok && note.trim().length < 3} onClick={save}>
          {ok ? "Marcar como resolvido" : "Marcar como não resolvido"}</Button>
      </>}>
      <div className="stack">
        <p className="subtext">{value.t.requester.name} · {value.t.project_name} · {value.t.category}</p>
        <label className="field">
          <span className="field__label">{ok ? "Observação (opcional)" : "O que ficou pendente?"}</span>
          <textarea className="input textarea" rows={3} maxLength={1000} autoFocus value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={ok ? "Ex.: cliente confirmou por mensagem que a dúvida foi esclarecida." : "Ex.: líder não respondeu; cliente aguarda retorno sobre a laje."} />
        </label>
        {!ok && <p className="subtext">Depois você pode abrir um chamado para a liderança do projeto direto da lista.</p>}
      </div>
    </Modal>
  );
}

/** Resumo para o painel inicial do CS. */
export function SupportSummary() {
  const navigate = useNavigate();
  const q = useAsync(() => api.supportTickets(), []);
  if (!q.data) return null;
  const s = supportStats(q.data);
  return (
    <section aria-label="Pedidos de ajuda dos clientes" className="csh__group">
      <span className="label">Pedidos de ajuda dos clientes</span>
      <div className="metrics">
        <MetricCard label="Aguardando validação" value={s.open} tone={s.open ? "warning" : "quiet"} hint="Confirme com o cliente se resolveu" onClick={() => navigate("/cs?aba=atendimentos")} />
        <MetricCard label="Abertos no mês" value={s.month} hint={s.top ? `Mais pedido: ${s.top}` : "Nenhum no mês"} onClick={() => navigate("/cs?aba=atendimentos")} />
        <MetricCard label="Resolvidos" value={s.resolvedPct != null ? `${s.resolvedPct}%` : "—"} hint={s.closed ? plural(s.closed, "validado", "validados") : "Nenhum validado ainda"} />
        <MetricCard label="Sem WhatsApp cadastrado" value={s.noWhatsapp} tone={s.noWhatsapp ? "danger" : "quiet"} hint="Cadastre em Configurações" />
      </div>
    </section>
  );
}
