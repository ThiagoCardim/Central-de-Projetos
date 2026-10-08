import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, Field, Input, LoadError, MetricCard, SearchInput, Select, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { Drawer, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { OptionPicker } from "@/components/ui/OptionPicker";
import { cx, formatDate, formatDateTime, formatMoney, plural } from "@/utils/format";
import { normName } from "@/components/ui/StepPicker";
import type { ApprovalRate, ApprovalRecord, ApprovalStatus } from "@/types/domain";
import { APPROVAL_STATUS_LABEL, ApprovalBadge, Money, ProofLink } from "./ProjectApprovals";

/* ==========================================================================
   Controle de aprovações e comissões
   ADM: valores padrão, liberação e pagamento. Líder de aprovação: confere
   o comprovante das aprovações dos seus projetos.
   ========================================================================== */
type Tab = "comissoes" | "valores";
type Filter = "all" | "review" | "rejected" | "to_release" | "released" | "paid";
const FILTERS: { value: Filter; label: string; match: (s: ApprovalStatus) => boolean }[] = [
  { value: "all", label: "Todas", match: () => true },
  { value: "review", label: "Para conferir", match: (s) => s === "awaiting_review" },
  { value: "rejected", label: "Comprovante recusado", match: (s) => s === "proof_rejected" },
  { value: "to_release", label: "A liberar", match: (s) => s === "to_release" },
  { value: "released", label: "Liberadas", match: (s) => s === "released" },
  { value: "paid", label: "Pagas", match: (s) => s === "paid" },
];
const sum = (xs: ApprovalRecord[]) => xs.reduce((a, x) => a + (x.amount ?? 0), 0);

export function ApprovalsPage() {
  useDocumentTitle("Aprovações");
  const { permissions } = useAuth();
  const isGlobal = permissions?.role === "global_admin";
  const isAdmin = !!permissions?.can_admin_approvals || isGlobal;
  const [tab, setTab] = useState<Tab>(useSearchParam("aba") === "valores" ? "valores" : "comissoes");
  const [tenant, setTenant] = useState<string>(isGlobal ? "" : permissions?.tenant_id ?? "");
  const tenants = useAsync(() => (isGlobal ? api.listTenants() : Promise.resolve([])), [isGlobal]);

  return (
    <div className="page aprv">
      <PageHead title="Aprovações"
        subtitle="Aprovações registradas, conferência dos comprovantes e liberação das comissões do setor de aprovação" />
      <div className="settings__bar">
        <Tabs<Tab> label="Aprovações" value={tab} onChange={setTab} tabs={[
          { value: "comissoes", label: "Aprovações e comissões" }, { value: "valores", label: "Valores padrão" },
        ]} />
        {isGlobal && (
          <div className="settings__unit">
            <OptionPicker label="Unidade" value={tenant} loading={tenants.loading}
              options={[{ value: "", label: "Todas as unidades" }, ...(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name }))]}
              onChange={(v) => setTenant(v ?? "")} />
          </div>
        )}
      </div>
      {tab === "comissoes"
        ? <Commissions tenant={tenant || null} />
        : <Rates tenantId={tenant || (isGlobal ? (tenants.data?.[0]?.id ?? "") : permissions?.tenant_id ?? "")} canEdit={isAdmin} />}
    </div>
  );
}

/* ---------- Aprovações e comissões ---------- */
function Commissions({ tenant }: { tenant: string | null }) {
  const q = useAsync(() => api.approvalsList(tenant), [tenant]);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = q.data ?? [];
  const types = useMemo(() => [...new Map(rows.map((r) => [r.type_id, r.type_name])).entries()], [rows]);
  const s = normName(search);
  const base = rows.filter((r) => (!type || r.type_id === type)
    && (!s || normName(`${r.project_name} ${r.project_code ?? ""} ${r.client_name ?? ""} ${r.recipient?.name ?? ""} ${r.protocol_number ?? ""}`).includes(s)));
  const list = base.filter((r) => FILTERS.find((f) => f.value === filter)!.match(r.status));
  const open = rows.find((r) => r.id === openId) ?? null;

  const review = rows.filter((r) => r.status === "awaiting_review");
  const toRelease = rows.filter((r) => r.status === "to_release");
  const released = rows.filter((r) => r.status === "released");
  const month = new Date().toISOString().slice(0, 7);
  const paidMonth = rows.filter((r) => r.status === "paid" && (r.paid_at ?? "").slice(0, 7) === month);

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (q.loading && !q.data) return <div className="stack"><Skeleton height={96} radius={16} /><Skeleton height={320} radius={16} /></div>;

  return (
    <div className="stack aprv__body">
      <div className="metrics">
        <MetricCard label="Para conferir" value={review.length} tone={review.length ? "warning" : "quiet"}
          hint="Comprovantes aguardando o líder" onClick={() => setFilter("review")} />
        <MetricCard label="A liberar" value={formatMoney(sum(toRelease))} tone={toRelease.length ? "brand" : "quiet"}
          hint={plural(toRelease.length, "aprovação conferida", "aprovações conferidas")} onClick={() => setFilter("to_release")} />
        <MetricCard label="Liberadas" value={formatMoney(sum(released))} hint={`${plural(released.length, "comissão", "comissões")} aguardando pagamento`}
          onClick={() => setFilter("released")} />
        <MetricCard label="Pagas no mês" value={formatMoney(sum(paidMonth))} hint={plural(paidMonth.length, "comissão", "comissões")}
          onClick={() => setFilter("paid")} />
      </div>

      <div className="aprv__filters">
        <div className="chips" role="group" aria-label="Situação">
          {FILTERS.map((f) => {
            const n = base.filter((r) => f.match(r.status)).length;
            return (
              <button key={f.value} type="button" className="chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                {f.label}{f.value !== "all" && n > 0 && <span className="chip__n">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="aprv__search">
          <SearchInput aria-label="Buscar" placeholder="Projeto, cliente, comissionado ou protocolo" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select aria-label="Tipo de aprovação" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Todos os tipos</option>
            {types.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </Select>
        </div>
      </div>

      <Card flush title={FILTERS.find((f) => f.value === filter)!.label} count={list.length || undefined}>
        {list.length === 0 ? (
          <EmptyState compact icon="seal" title={rows.length ? "Nada nesta situação." : "Nenhuma aprovação registrada ainda."}
            text={rows.length ? "Troque o filtro para ver as demais." : "Quando a equipe marcar “Projeto aprovado” num projeto, a aprovação aparece aqui para conferência."} />
        ) : (
          <ul className="aprv__list">
            {list.map((r) => <Row key={r.id} r={r} onOpen={() => setOpenId(r.id)} onChanged={() => void q.reload()} />)}
          </ul>
        )}
      </Card>

      <ByPerson rows={base} />

      <ApprovalDrawer r={open} onClose={() => setOpenId(null)} onChanged={() => void q.reload()} />
    </div>
  );
}

function Row({ r, onOpen, onChanged }: { r: ApprovalRecord; onOpen: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function quick(fn: () => Promise<void>, msg: string) {
    setBusy(true);
    try { await fn(); toast(msg); onChanged(); } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  const primary = r.can_review
    ? <Button size="sm" variant="secondary" onClick={onOpen}>Conferir</Button>
    : r.can_admin && r.status === "to_release"
      ? <Button size="sm" loading={busy} disabled={r.amount == null} title={r.amount == null ? "Defina o valor antes" : undefined}
          onClick={() => quick(() => api.approvalSetStatus(r.id, "released"), "Comissão liberada.")}>Liberar</Button>
      : r.can_admin && r.status === "released"
        ? <Button size="sm" variant="secondary" loading={busy} onClick={() => quick(() => api.approvalSetStatus(r.id, "paid"), "Comissão marcada como paga.")}>Marcar paga</Button>
        : null;
  return (
    <li className="aprv__row">
      <button type="button" className="aprv__open" onClick={onOpen} aria-label={`Abrir ${r.type_name} · ${r.project_name}`}>
        <span className="aprv__type"><Badge tag>{r.type_name}</Badge></span>
        <span className="aprv__proj">
          <span className="aprv__pname">{r.project_name}</span>
          <span className="aprv__meta">
            {r.client_name ?? "—"} · Aprovado em {formatDate(r.approved_on, true)}{r.protocol_number ? ` · Protocolo ${r.protocol_number}` : ""}
            {r.tenant_name && <> · {r.tenant_name}</>}
          </span>
        </span>
        <span className="aprv__who">
          {r.recipient ? <><Avatar name={r.recipient.name} src={r.recipient.avatar_url} size="sm" /><span className="truncate">{r.recipient.name}</span></> : <span className="subtext">Sem comissionado</span>}
        </span>
        <span className="aprv__amount"><Money value={r.amount} /></span>
        <span className="aprv__status"><ApprovalBadge status={r.status} /></span>
      </button>
      <span className="aprv__act">{primary}</span>
    </li>
  );
}

/* ---------- Resumo por comissionado ---------- */
function ByPerson({ rows }: { rows: ApprovalRecord[] }) {
  const people = useMemo(() => {
    const m = new Map<string, { name: string; avatar: string | null; review: number; toRelease: number; released: number; paid: number; n: number }>();
    for (const r of rows) {
      if (!r.recipient) continue;
      const x = m.get(r.recipient.id) ?? { name: r.recipient.name, avatar: r.recipient.avatar_url, review: 0, toRelease: 0, released: 0, paid: 0, n: 0 };
      x.n += 1;
      const v = r.amount ?? 0;
      if (r.status === "awaiting_review" || r.status === "proof_rejected") x.review += v;
      else if (r.status === "to_release") x.toRelease += v;
      else if (r.status === "released") x.released += v;
      else if (r.status === "paid") x.paid += v;
      m.set(r.recipient.id, x);
    }
    return [...m.entries()].sort((a, b) => (b[1].toRelease + b[1].released) - (a[1].toRelease + a[1].released) || a[1].name.localeCompare(b[1].name));
  }, [rows]);
  if (!people.length) return null;
  return (
    <Card flush title="Por comissionado" count={people.length}>
      <div className="aprv__table" role="table" aria-label="Comissões por pessoa">
        <div className="aprv__trow aprv__trow--head" role="row">
          <span role="columnheader">Pessoa</span><span role="columnheader">Em conferência</span><span role="columnheader">A liberar</span>
          <span role="columnheader">Liberada</span><span role="columnheader">Paga</span>
        </div>
        {people.map(([id, p]) => (
          <div key={id} className="aprv__trow" role="row">
            <span role="cell" className="aprv__person"><Avatar name={p.name} src={p.avatar} size="sm" /><span className="truncate">{p.name}</span>
              <span className="subtext">{plural(p.n, "aprovação", "aprovações")}</span></span>
            <span role="cell" className="num" data-label="Em conferência">{formatMoney(p.review)}</span>
            <span role="cell" className="num aprv__strong" data-label="A liberar">{formatMoney(p.toRelease)}</span>
            <span role="cell" className="num" data-label="Liberada">{formatMoney(p.released)}</span>
            <span role="cell" className="num" data-label="Paga">{formatMoney(p.paid)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- Detalhe com ações ---------- */
function ApprovalDrawer({ r, onClose, onChanged }: { r: ApprovalRecord | null; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const staff = useAsync(() => (r?.can_admin ? api.listStaff(r.tenant_id) : Promise.resolve([])), [r?.id, r?.can_admin]);

  useEffect(() => {
    setRejecting(false); setNote(""); setCancelOpen(false);
    setAmount(r?.amount != null ? String(r.amount).replace(".", ",") : "");
    setRecipient(r?.recipient?.id ?? "");
  }, [r?.id, r?.amount, r?.recipient?.id]);

  if (!r) return null;
  const editable = r.can_admin && r.status !== "paid" && r.status !== "cancelled";
  const amountNum = amount.trim() === "" ? null : Number(amount.replace(/\./g, "").replace(",", "."));
  const dirty = editable && ((amountNum ?? null) !== (r.amount ?? null) || recipient !== (r.recipient?.id ?? ""));

  async function act(key: string, fn: () => Promise<void>, msg: string, close = false) {
    setBusy(key);
    try { await fn(); toast(msg); onChanged(); if (close) onClose(); }
    catch (e) { toast((e as Error).message, "error"); }
    finally { setBusy(null); }
  }

  const steps: { label: string; who?: string | null; when: string | null; done: boolean; bad?: boolean }[] = [
    { label: "Aprovação registrada", who: r.registered_by?.name, when: r.registered_at, done: true },
    { label: r.status === "proof_rejected" ? "Comprovante recusado" : "Comprovante conferido", who: r.reviewed_by?.name, when: r.reviewed_at,
      done: !!r.reviewed_at, bad: r.status === "proof_rejected" },
    { label: "Comissão liberada", when: r.released_at, done: !!r.released_at },
    { label: "Comissão paga", when: r.paid_at, done: !!r.paid_at },
  ];

  return (
    <Drawer open={!!r} onClose={onClose} title={`${r.type_name} · ${r.project_name}`}
      subtitle={<>{r.client_name ?? "—"}{r.project_code ? ` · ${r.project_code}` : ""}</>}
      footer={
        r.can_review ? (rejecting ? (
          <>
            <Button variant="ghost" onClick={() => setRejecting(false)}>Voltar</Button>
            <Button variant="danger" loading={busy === "reject"} disabled={note.trim().length < 3}
              onClick={() => act("reject", () => api.approvalReview(r.id, false, note.trim()), "Comprovante recusado. Quem registrou foi avisado.")}>Recusar comprovante</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" icon="x" onClick={() => setRejecting(true)}>Recusar</Button>
            <Button icon="check" loading={busy === "ok"} onClick={() => act("ok", () => api.approvalReview(r.id, true), "Comprovante conferido. Comissão pronta para liberar.")}>Comprovante correto</Button>
          </>
        )) : r.can_admin && r.status === "to_release" ? (
          <Button icon="check" loading={busy === "rel"} disabled={r.amount == null || dirty}
            onClick={() => act("rel", () => api.approvalSetStatus(r.id, "released"), "Comissão liberada.")}>Liberar comissão</Button>
        ) : r.can_admin && r.status === "released" ? (
          <>
            <Button variant="ghost" loading={busy === "back"} onClick={() => act("back", () => api.approvalSetStatus(r.id, "to_release"), "Liberação desfeita.")}>Desfazer liberação</Button>
            <Button icon="check" loading={busy === "pay"} onClick={() => act("pay", () => api.approvalSetStatus(r.id, "paid"), "Comissão marcada como paga.")}>Marcar como paga</Button>
          </>
        ) : r.can_admin && r.status === "paid" ? (
          <Button variant="ghost" loading={busy === "unpay"} onClick={() => act("unpay", () => api.approvalSetStatus(r.id, "released"), "Pagamento desfeito.")}>Desfazer pagamento</Button>
        ) : undefined
      }>
      <div className="aprd">
        <div className="aprd__status"><ApprovalBadge status={r.status} /><Link to={`/projetos/${r.project_id}`} className="link">Abrir projeto</Link></div>

        <dl className="kv">
          <div><dt>Aprovado em</dt><dd className="num">{formatDate(r.approved_on, true)}</dd></div>
          <div><dt>Protocolo</dt><dd>{r.protocol_number ?? "—"}</dd></div>
          <div><dt>Comprovante</dt><dd><ProofLink path={r.proof.path} name={r.proof.name} /></dd></div>
          {r.notes && <div><dt>Observação</dt><dd>{r.notes}</dd></div>}
          {r.tenant_name && <div><dt>Unidade</dt><dd>{r.tenant_name}</dd></div>}
        </dl>

        {r.review_note && (
          <Alert tone={r.status === "proof_rejected" ? "danger" : "info"} title={r.status === "proof_rejected" ? "Motivo da recusa" : "Observação da conferência"}>{r.review_note}</Alert>
        )}
        {r.can_review && rejecting && (
          <Field label="O que está errado no comprovante?" required>
            {({ id }) => <textarea id={id} className="input textarea" rows={3} maxLength={500} autoFocus value={note}
              placeholder="Ex.: documento ilegível, é o protocolo e não a aprovação" onChange={(e) => setNote(e.target.value)} />}
          </Field>
        )}
        {r.can_review && !rejecting && (
          <p className="subtext">Abra o comprovante e confira se ele comprova a aprovação de <b>{r.type_name}</b> neste projeto.</p>
        )}

        <section className="aprd__box">
          <h3>Comissão</h3>
          {editable ? (
            <div className="aprd__edit">
              <Field label="Valor (R$)" hint={r.amount == null ? "Sem valor padrão para este tipo. Defina antes de liberar." : undefined}>
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" placeholder="0,00" value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))} />}
              </Field>
              <Field label="Comissionado">
                {({ id }) => (
                  <Select id={id} value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                    {!recipient && <option value="">Escolha</option>}
                    {r.recipient && !(staff.data ?? []).some((p) => p.id === r.recipient!.id) && <option value={r.recipient.id}>{r.recipient.name}</option>}
                    {(staff.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                )}
              </Field>
              {dirty && (
                <Button size="sm" icon="check" loading={busy === "save"} disabled={amountNum != null && (Number.isNaN(amountNum) || amountNum < 0)}
                  onClick={() => act("save", () => api.approvalUpdate(r.id, amountNum, recipient || null), "Comissão atualizada.")}>Salvar comissão</Button>
              )}
            </div>
          ) : (
            <dl className="kv">
              <div><dt>Valor</dt><dd><Money value={r.amount} /></dd></div>
              <div><dt>Comissionado</dt><dd>{r.recipient?.name ?? "—"}</dd></div>
            </dl>
          )}
        </section>

        <section className="aprd__box">
          <h3>Andamento</h3>
          <ol className="aprd__steps">
            {steps.map((s) => (
              <li key={s.label} className={cx(s.done && "is-done", s.bad && "is-bad")}>
                <span className="aprd__dot" aria-hidden="true">{s.done && <Icon name={s.bad ? "x" : "check"} size={11} />}</span>
                <span className="grow">{s.label}{s.who && <span className="subtext"> · {s.who}</span>}</span>
                <span className="subtext num">{s.when ? formatDateTime(s.when) : ""}</span>
              </li>
            ))}
          </ol>
        </section>

        {r.can_admin && r.status !== "paid" && (
          <div className="aprd__cancel">
            <Button size="sm" variant="danger-ghost" onClick={() => setCancelOpen(true)}>Cancelar este registro</Button>
          </div>
        )}
      </div>
      <CancelModal open={cancelOpen} onClose={() => setCancelOpen(false)}
        onConfirm={(why) => act("cancel", () => api.approvalSetStatus(r.id, "cancelled", why), "Registro cancelado.", true)} busy={busy === "cancel"} />
    </Drawer>
  );
}

function CancelModal({ open, onClose, onConfirm, busy }: { open: boolean; onClose: () => void; onConfirm: (why: string) => void; busy: boolean }) {
  const [why, setWhy] = useState("");
  useEffect(() => { if (open) setWhy(""); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Cancelar este registro?"
      footer={<><Button variant="ghost" onClick={onClose}>Voltar</Button>
        <Button variant="danger" loading={busy} disabled={why.trim().length < 3} onClick={() => onConfirm(why.trim())}>Cancelar registro</Button></>}>
      <p>A aprovação sai do controle e a comissão não é paga. Use quando o registro foi feito por engano.</p>
      <Field label="Motivo" required>
        {({ id }) => <Input id={id} autoFocus value={why} maxLength={500} onChange={(e) => setWhy(e.target.value)} />}
      </Field>
    </Modal>
  );
}

/* ---------- Valores padrão ---------- */
function Rates({ tenantId, canEdit }: { tenantId: string; canEdit: boolean }) {
  const toast = useToast();
  const q = useAsync(() => (tenantId ? api.approvalRatesList(tenantId) : Promise.resolve([] as ApprovalRate[])), [tenantId]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setVals(Object.fromEntries(q.data.map((r) => [r.type_id, r.amount != null ? r.amount.toFixed(2).replace(".", ",") : ""])));
  }, [q.data]);

  if (!tenantId) return <Card><EmptyState compact icon="building" title="Escolha uma unidade." text="Os valores padrão são definidos por unidade." /></Card>;
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (q.loading && !q.data) return <Skeleton height={320} radius={16} />;

  const parse = (v: string) => (v.trim() === "" ? null : Number(v.replace(/\./g, "").replace(",", ".")));
  async function save(r: ApprovalRate) {
    const n = parse(vals[r.type_id] ?? "");
    if (n == null || Number.isNaN(n) || n < 0) { toast("Informe um valor válido.", "error"); return; }
    setBusy(r.type_id);
    try { await api.approvalRateSave(tenantId, r.type_id, n); toast(`Valor de ${r.name} salvo.`); await q.reload(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }

  return (
    <div className="settings__grid">
      <Card title="Comissão por tipo de aprovação" flush>
        <ul className="rates">
          {(q.data ?? []).map((r) => {
            const v = vals[r.type_id] ?? "";
            const changed = parse(v) !== (r.amount ?? null);
            return (
              <li key={r.type_id} className="rate">
                <span className="rate__name">{r.name}</span>
                {canEdit ? (
                  <form className="rate__edit" onSubmit={(e) => { e.preventDefault(); void save(r); }}>
                    <div className="rate__input">
                      <span aria-hidden="true">R$</span>
                      <Input aria-label={`Valor padrão de ${r.name}`} inputMode="decimal" placeholder="0,00" value={v}
                        onChange={(e) => setVals({ ...vals, [r.type_id]: e.target.value.replace(/[^\d.,]/g, "") })} />
                    </div>
                    <Button size="sm" type="submit" variant={changed ? "primary" : "ghost"} disabled={!changed} loading={busy === r.type_id}>Salvar</Button>
                  </form>
                ) : <Money value={r.amount} muted="Não definido" />}
              </li>
            );
          })}
        </ul>
      </Card>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>Quando a equipe marca <b>Projeto aprovado</b> e anexa o comprovante, a aprovação entra aqui com o valor padrão do tipo.</p>
        <p>O <b>líder de aprovação</b> confere o comprovante. Conferido, a comissão fica <b>a liberar</b> para a administração, que libera e depois marca como paga.</p>
        <p>Mudar o valor padrão vale para as próximas aprovações. O valor de uma aprovação já registrada pode ser ajustado nela, até ser paga.</p>
      </aside>
    </div>
  );
}
