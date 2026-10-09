import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useNavigate, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { Button, Card, EmptyState, LoadError, MetricCard, SearchInput, Segmented, Skeleton, Tabs } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate, plural } from "@/utils/format";
import { normName } from "@/components/ui/StepPicker";
import type { CsDashboard, CsKind, CsRequest } from "@/types/domain";
import { CS_KIND, CsRow, NewRequestModal, RequestDrawer } from "./csUi";
import { NpsPanel, npsZone } from "./NpsPanel";
import { SupportPanel, SupportSummary } from "@/pages/support/SupportPanel";
import { ClientWaitsOverviewCard } from "@/pages/schedule/ClientWaits";

/* ==========================================================================
   Customer Success: chamados (CS e liderança) e painel do CS
   ========================================================================== */
type Filter = "active" | "waiting" | "answered" | "late" | "closed" | "all";
const FILTERS: { value: Filter; label: string; match: (r: CsRequest) => boolean }[] = [
  { value: "active", label: "Em aberto", match: (r) => r.status === "open" || r.status === "answered" },
  { value: "waiting", label: "Aguardando equipe", match: (r) => r.status === "open" },
  { value: "answered", label: "Respondidos", match: (r) => r.status === "answered" },
  { value: "late", label: "Prazo vencido", match: (r) => r.overdue },
  { value: "closed", label: "Encerrados", match: (r) => r.status === "resolved" || r.status === "cancelled" },
  { value: "all", label: "Todos", match: () => true },
];

type MainTab = "chamados" | "atendimentos" | "nps";

export function CsPage() {
  useDocumentTitle("Customer Success");
  const { permissions } = useAuth();
  const isCs = !!permissions?.is_cs;
  const canOpen = isCs || permissions?.role === "unit_admin" || permissions?.role === "global_admin";
  const deep = useSearchParam("chamado");
  const aba = useSearchParam("aba");
  const [mainTab, setMainTab] = useState<MainTab>(aba === "nps" || aba === "atendimentos" ? aba : "chamados");
  useEffect(() => { if (aba === "nps" || aba === "atendimentos") setMainTab(aba); }, [aba]);
  const [scope, setScope] = useState<"mine" | "all">(isCs ? "all" : "mine");
  const q = useAsync(() => api.csRequests(scope), [scope]);
  const [filter, setFilter] = useState<Filter>("active");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(deep);
  const [newKind, setNewKind] = useState<CsKind | null>(null);
  const [newProject, setNewProject] = useState<string | null>(null);
  useEffect(() => { if (deep) { setOpenId(deep); setMainTab("chamados"); } }, [deep]);

  const rows = q.data ?? [];
  const s = normName(search);
  const base = rows.filter((r) => !s || normName(`${r.title} ${r.project_name} ${r.client_name ?? ""} ${r.project_code ?? ""}`).includes(s));
  const list = base.filter(FILTERS.find((f) => f.value === filter)!.match);

  return (
    <div className="page cs">
      <PageHead title="Customer Success"
        subtitle={isCs ? "Seus chamados e alertas para a equipe" : "Chamados e alertas do Customer Success para a liderança dos projetos"}
        actions={canOpen ? (
          <>
            <Button variant="outline" icon="alert" onClick={() => { setNewProject(null); setNewKind("alert"); }}>Criar alerta</Button>
            <Button icon="headset" onClick={() => { setNewProject(null); setNewKind("clarification"); }}>Novo chamado</Button>
          </>
        ) : undefined} />
      <Tabs<MainTab> label="Customer Success" value={mainTab} onChange={setMainTab} tabs={[
        { value: "chamados", label: "Chamados", count: rows.filter((r) => r.status === "open" || r.status === "answered").length || undefined },
        { value: "atendimentos", label: "Pedidos de ajuda" },
        { value: "nps", label: "NPS" },
      ]} />
      {mainTab === "nps" ? <NpsPanel /> : mainTab === "atendimentos"
        ? <SupportPanel onOpenRequest={canOpen ? (pid) => { setNewProject(pid); setNewKind("clarification"); } : undefined} /> : <>
      {!isCs && (
        <Segmented<"mine" | "all"> label="Escopo" value={scope} onChange={setScope} options={[
          { value: "mine", label: "Para mim" }, { value: "all", label: "Todos dos meus projetos" },
        ]} />
      )}
      <div className="aprv__filters">
        <div className="chips" role="group" aria-label="Situação">
          {FILTERS.map((f) => {
            const n = base.filter(f.match).length;
            return (
              <button key={f.value} type="button" className="chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
                {f.label}{f.value !== "all" && f.value !== "closed" && n > 0 && <span className={cx("chip__n", f.value === "late" && "is-bad")}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="cs__search">
          <SearchInput aria-label="Buscar chamado" placeholder="Assunto, projeto ou cliente" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      {q.error ? <LoadError message={q.error} onRetry={() => void q.reload()} />
        : q.loading && !q.data ? <Skeleton height={320} radius={16} />
        : (
          <Card flush>
            {list.length === 0 ? (
              <EmptyState compact icon="headset" title={rows.length ? "Nenhum chamado nesta situação." : isCs ? "Você ainda não abriu chamados." : "Nenhum chamado do CS para você."}
                text={rows.length ? "Troque o filtro para ver os demais." : isCs ? "Use “Novo chamado” para pedir um esclarecimento ou levar uma dúvida do cliente à equipe." : "Quando o Customer Success abrir um chamado num projeto que você lidera, ele aparece aqui."} />
            ) : (
              <ul className="cslist">{list.map((r) => <CsRow key={r.id} r={r} onOpen={() => setOpenId(r.id)} />)}</ul>
            )}
          </Card>
        )}
      </>}
      <RequestDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void q.reload()} />
      <NewRequestModal open={!!newKind} projectId={newProject} defaultKind={newKind ?? "clarification"} onClose={() => setNewKind(null)}
        onCreated={(id) => { setNewKind(null); void q.reload(); setMainTab("chamados"); setOpenId(id); }} />
    </div>
  );
}

/* ---------- Painel inicial do CS ---------- */
export function CsHome() {
  const navigate = useNavigate();
  const q = useAsync(() => api.csDashboard(), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<CsKind | null>(null);
  const [newProject, setNewProject] = useState<string | null>(null);
  const d = q.data;

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (q.loading && !d) return <div className="stack"><Skeleton height={110} radius={16} /><Skeleton height={320} radius={16} /></div>;
  if (!d) return null;
  const c = d.counts;

  return (
    <div className="csh">
      <div className="csh__bar">
        <p className="subtext">{d.scope === "network" ? "Todos os projetos da rede" : "Projetos da sua unidade"} · {plural(d.projects.active, "projeto em andamento", "projetos em andamento")}</p>
        <div className="row">
          <Button variant="outline" icon="alert" onClick={() => { setNewProject(null); setNewKind("alert"); }}>Criar alerta</Button>
          <Button icon="headset" onClick={() => { setNewProject(null); setNewKind("clarification"); }}>Novo chamado</Button>
        </div>
      </div>

      <section aria-label="Chamados" className="csh__group">
        <span className="label">Chamados</span>
        <div className="metrics">
          <MetricCard label="Em aberto" value={c.open} hint={`${c.awaiting_team} aguardando equipe · ${c.answered} respondidos`} onClick={() => navigate("/cs")} />
          <MetricCard label="Alertas e urgentes" value={c.urgent_open} tone={c.urgent_open ? "danger" : "quiet"} hint="Em aberto" onClick={() => navigate("/cs")} />
          <MetricCard label="Prazo vencido" value={c.overdue} tone={c.overdue ? "warning" : "quiet"} hint="Sem resposta da equipe" onClick={() => navigate("/cs")} />
          <MetricCard label="1ª resposta (média)" value={d.response.avg_hours != null ? `${String(d.response.avg_hours).replace(".", ",")} h` : "—"}
            hint={d.response.answered ? `Últimos 30 dias · ${plural(d.response.answered, "chamado", "chamados")}` : "Sem respostas nos últimos 30 dias"} />
          <MetricCard label="Respondidos no prazo" value={d.response.on_time_pct != null ? `${d.response.on_time_pct}%` : "—"}
            tone={d.response.on_time_pct != null && d.response.on_time_pct < 80 ? "warning" : undefined} hint="Últimos 30 dias" />
          <MetricCard label="Encerrados no mês" value={c.resolved_month} hint={`${plural(c.created_month, "aberto", "abertos")} no mês`} />
        </div>
      </section>

      <div className="csh__grid">
        <Card title="Precisa de atenção" count={d.attention.length || undefined} flush
          action={<Link to="/cs" className="link">Ver todos</Link>}>
          {d.attention.length === 0
            ? <EmptyState compact icon="checkCircle" title="Nada urgente agora." text="Alertas, chamados urgentes e prazos vencidos aparecem aqui." />
            : <ul className="cslist">{d.attention.map((r) => <CsRow key={r.id} r={r} onOpen={() => setOpenId(r.id)} />)}</ul>}
        </Card>
        <div className="stack">
          <ClientWaitsOverviewCard />
          <Card title="Chamados por tipo">
            <ul className="cskinds">
              {d.by_kind.map((k) => (
                <li key={k.kind}>
                  <span className={cx("cskinds__icon", `cskind--${k.kind}`)}><Icon name={CS_KIND[k.kind].icon} size={15} /></span>
                  <span className="grow">{CS_KIND[k.kind].label}</span>
                  <span className="cskinds__n"><b>{k.open}</b> em aberto</span>
                  <span className="cskinds__m">{k.month} no mês</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Chamados abertos por semana">
            <WeekBars trend={d.trend} />
          </Card>
        </div>
      </div>

      <SupportSummary />

      <NpsSummary />

      <section aria-label="Projetos" className="csh__group">
        <span className="label">Projetos</span>
        <div className="metrics">
          <MetricCard label="Em andamento" value={d.projects.active} onClick={() => navigate("/projetos")} />
          <MetricCard label="Com etapas atrasadas" value={d.projects.with_overdue} tone={d.projects.with_overdue ? "danger" : "quiet"} />
          <MetricCard label="Aguardando o cliente" value={d.projects.waiting_client} tone={d.projects.waiting_client ? "warning" : "quiet"} />
        </div>
      </section>

      <div className="csh__grid csh__grid--even">
        <Card title="Projetos que pedem acompanhamento" count={d.at_risk.length || undefined} flush>
          {d.at_risk.length === 0 ? <EmptyState compact icon="checkCircle" title="Nenhum projeto em risco." text="Sem etapas atrasadas nem pendências com o cliente." /> : (
            <ul className="csrisk">
              {d.at_risk.map((p) => (
                <li key={p.id}>
                  <Link to={`/projetos/${p.id}`} className="csrisk__main">
                    <span className="csrisk__name">{p.name}</span>
                    <span className="csrisk__meta">{p.client_name ?? "—"}{p.code ? ` · ${p.code}` : ""}{p.next_due ? ` · próxima entrega ${formatDate(p.next_due, true)}` : ""}</span>
                    <span className="csrisk__flags">
                      {p.overdue_steps > 0 && <span className="csflag is-bad">{plural(p.overdue_steps, "etapa atrasada", "etapas atrasadas")}{p.max_overdue_days ? ` · até ${p.max_overdue_days} d` : ""}</span>}
                      {p.waiting_client > 0 && <span className="csflag is-warn">{plural(p.waiting_client, "aguarda o cliente", "aguardam o cliente")}</span>}
                      {p.open_requests > 0 && <span className="csflag">{plural(p.open_requests, "chamado aberto", "chamados abertos")}</span>}
                    </span>
                  </Link>
                  <Button size="sm" variant="ghost" iconOnly icon="headset" onClick={() => { setNewProject(p.id); setNewKind("clarification"); }}>Abrir chamado sobre {p.name}</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Próximas entregas ao cliente" count={d.upcoming.length || undefined} flush
          action={<span className="subtext">14 dias</span>}>
          {d.upcoming.length === 0 ? <EmptyState compact icon="calendar" title="Nenhuma entrega prevista nos próximos 14 dias." /> : (
            <ul className="csup">
              {d.upcoming.map((u) => (
                <li key={u.task_id}>
                  <span className="csup__date"><b>{formatDate(u.planned_end_date)}</b><small>{weekday(u.planned_end_date)}</small></span>
                  <Link to={`/projetos/${u.project_id}/cronograma?etapa=${u.task_id}`} className="csup__main">
                    <span className="csup__task">{u.task}</span>
                    <span className="csup__meta">{u.project_name} · {u.service}{u.responsible ? ` · ${u.responsible}` : ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <RequestDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void q.reload()} />
      <NewRequestModal open={!!newKind} projectId={newProject} defaultKind={newKind ?? "clarification"} onClose={() => setNewKind(null)}
        onCreated={(id) => { setNewKind(null); void q.reload(); setOpenId(id); }} />
    </div>
  );
}

const weekday = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");

function WeekBars({ trend }: { trend: CsDashboard["trend"] }) {
  const max = Math.max(1, ...trend.map((t) => t.created));
  const total = trend.reduce((a, t) => a + t.created, 0);
  if (total === 0) return <p className="subtext">Nenhum chamado nas últimas 8 semanas.</p>;
  return (
    <div className="wbars" role="img" aria-label={`Chamados abertos nas últimas 8 semanas: ${trend.map((t) => t.created).join(", ")}`}>
      {trend.map((t) => (
        <div key={t.week} className="wbars__col" title={`Semana de ${formatDate(t.week)}: ${plural(t.created, "chamado aberto", "chamados abertos")}, ${t.resolved} encerrado(s)`}>
          <span className="wbars__val">{t.created || ""}</span>
          <span className="wbars__bar" style={{ height: `${Math.max(t.created ? 6 : 2, (t.created / max) * 100)}%` }} data-empty={!t.created || undefined} />
          <span className="wbars__lbl">{`${t.week.slice(8, 10)}/${t.week.slice(5, 7)}`}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- No projeto ---------- */
export function ProjectCsCard({ projectId }: { projectId: string }) {
  const { permissions } = useAuth();
  const canOpen = !!permissions?.is_cs || permissions?.role === "unit_admin" || permissions?.role === "global_admin";
  const q = useAsync(() => api.csRequests("project", projectId), [projectId]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<CsKind | null>(null);
  const rows = q.data ?? [];
  const active = useMemo(() => rows.filter((r) => r.status === "open" || r.status === "answered"), [rows]);
  if (!canOpen && rows.length === 0) return null;
  return (
    <Card title="Customer Success" count={active.length || undefined} flush
      action={canOpen ? (
        <span className="row">
          <Button size="sm" variant="ghost" icon="alert" onClick={() => setNewKind("alert")}>Alerta</Button>
          <Button size="sm" variant="secondary" icon="headset" onClick={() => setNewKind("clarification")}>Abrir chamado</Button>
        </span>
      ) : undefined}>
      {q.loading && !q.data ? <div className="settings__pad"><Skeleton height={56} radius={10} /></div>
        : rows.length === 0 ? <EmptyState compact icon="headset" title="Nenhum chamado neste projeto." text="Peça um esclarecimento ou leve uma dúvida do cliente à liderança." />
        : <ul className="cslist">{(active.length ? active : rows.slice(0, 3)).map((r) => <CsRow key={r.id} r={r} showProject={false} onOpen={() => setOpenId(r.id)} />)}</ul>}
      {rows.length > active.length && active.length > 0 && (
        <div className="card__note"><Link to="/cs" className="link">{plural(rows.length - active.length, "chamado encerrado", "chamados encerrados")}</Link></div>
      )}
      <RequestDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void q.reload()} />
      <NewRequestModal open={!!newKind} projectId={projectId} defaultKind={newKind ?? "clarification"} onClose={() => setNewKind(null)}
        onCreated={(id) => { setNewKind(null); void q.reload(); setOpenId(id); }} />
    </Card>
  );
}

/* ---------- Início da liderança: chamados para responder ---------- */
export function CsInboxCard() {
  const q = useAsync(() => api.csRequests("mine"), []);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = (q.data ?? []).filter((r) => r.is_recipient && (r.status === "open" || r.status === "answered"));
  if (!items.length) return null;
  const waiting = items.filter((r) => r.status === "open").length;
  return (
    <Card title="Chamados do Customer Success" count={items.length} flush className={cx(items.some((r) => r.urgency === "urgent" && r.status === "open") && "csinbox--urgent")}
      action={<Link to="/cs" className="link">Ver todos</Link>}>
      {waiting > 0 && <p className="csinbox__hint"><Icon name="clock" size={14} /> {plural(waiting, "chamado aguarda sua resposta", "chamados aguardam sua resposta")}</p>}
      <ul className="cslist">{items.slice(0, 4).map((r) => <CsRow key={r.id} r={r} onOpen={() => setOpenId(r.id)} />)}</ul>
      <RequestDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void q.reload()} />
    </Card>
  );
}

/* ---------- NPS no painel do CS ---------- */
function NpsSummary() {
  const navigate = useNavigate();
  const q = useAsync(() => api.npsOverview(null, null), []);
  const o = q.data;
  if (!o) return null;
  const open = () => navigate("/cs?aba=nps");
  return (
    <section aria-label="Satisfação dos clientes" className="csh__group">
      <span className="label">Satisfação · NPS dos últimos 90 dias</span>
      <div className="metrics">
        <MetricCard label="NPS" value={o.nps ?? "—"} hint={npsZone(o.nps)} tone={o.nps != null && o.nps < 0 ? "danger" : o.nps != null && o.nps < 50 ? "warning" : undefined} onClick={open} />
        <MetricCard label="Respostas" value={o.responses} hint={o.completed_services ? `${Math.round((100 * o.answered_services) / o.completed_services)}% dos serviços concluídos` : "Nenhum serviço concluído"} onClick={open} />
        <MetricCard label="Detratores" value={o.detractors} tone={o.detractors ? "danger" : "quiet"} hint="Notas de 0 a 6" onClick={open} />
        <MetricCard label="Aguardando avaliação" value={o.pending_services} tone={o.pending_services ? "warning" : "quiet"} hint="Serviços concluídos" onClick={open} />
      </div>
    </section>
  );
}
