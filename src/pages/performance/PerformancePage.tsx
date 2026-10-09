import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { Link, useNavigate } from "@/lib/router";
import { OptionPicker } from "@/components/ui/OptionPicker";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { PageHead } from "@/layouts/AppLayout";
import {
  Avatar, Badge, Button, Card, EmptyState, LoadError, MetricCard, Segmented, Skeleton,
} from "@/components/ui/primitives";
import { Drawer } from "@/components/ui/overlays";
import type { PerfHighlights, PerfOverview, PerfRow } from "@/types/domain";
import { cx, plural } from "@/utils/format";
import { todayISO } from "@/pages/schedule/model";
import {
  BandPill, HighlightsGrid, monthLabel, monthOf, PersonPerformance, ScoreExplain, shiftMonth, TrendBars,
} from "./perfUi";
import { PersonRevisions, TeamRevisionsCard } from "@/pages/deliveries/RevisionsIndicator";

/* ==========================================================================
   Performance do time
   ========================================================================== */
export function PerformancePage() {
  useDocumentTitle("Performance");
  const { profile, permissions } = useAuth();
  const navigate = useNavigate();
  const isGlobal = permissions?.role === "global_admin";
  const [month, setMonth] = useState(() => monthOf(todayISO()));
  const [tenant, setTenant] = useState<string>(permissions?.tenant_id ?? "");
  const tenants = useAsync(() => (isGlobal ? api.listTenants() : Promise.resolve([])), [isGlobal]);
  const q = useAsync(() => api.performanceOverview(month, isGlobal ? tenant || null : null), [month, tenant]);
  const hl = useAsync(() => api.performanceHighlights(month), [month]);
  const [data, setData] = useState<PerfOverview | null>(null);
  useEffect(() => { if (q.data) setData(q.data); }, [q.data]);
  const [openId, setOpenId] = useState<string | null>(null);
  const isCurrent = month === monthOf(todayISO());

  const monthBar = (
    <div className="row pmonth">
      <Button size="sm" variant="ghost" iconOnly icon="chevronRight" className="flip" onClick={() => setMonth(shiftMonth(month, -1))}>Mês anterior</Button>
      <h3 className="pmonth__title">{monthLabel(month)}</h3>
      <Button size="sm" variant="ghost" iconOnly icon="chevronRight" disabled={isCurrent} onClick={() => setMonth(shiftMonth(month, 1))}>Próximo mês</Button>
      {!isCurrent && <Button size="sm" variant="secondary" onClick={() => setMonth(monthOf(todayISO()))}>Mês atual</Button>}
      {isCurrent && data && <span className="subtext">Parcial até hoje</span>}
      {isGlobal && (
        <div className="pmonth__unit">
          <OptionPicker label="Unidade" value={tenant} options={(tenants.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            loading={tenants.loading} onChange={(v) => v && setTenant(v)} />
        </div>
      )}
    </div>
  );

  if (q.error && !data) return <div className="page"><PageHead title="Performance" /><LoadError message={q.error} onRetry={() => void q.reload()} /></div>;

  return (
    <div className="page perf">
      <PageHead title={data?.scope === "self" ? "Minha performance" : "Performance do time"}
        subtitle="Entregas de etapas dos projetos e tarefas da liderança, medidas mês a mês"
        actions={data?.can_configure && <Button variant="outline" icon="sliders" onClick={() => navigate("/configuracoes?aba=performance")}>Regras da nota</Button>} />
      {monthBar}
      {!data ? <><Skeleton height={100} radius={16} /><Skeleton height={320} radius={16} /></> : data.scope === "self" ? (
        <div className="stack">
          <PersonPerformance profileId={profile!.id} month={month} settings={data.settings} self />
          <PersonRevisions profileId={profile!.id} month={month} self />
          <HighlightsSection data={hl.data} />
          <ScoreExplain settings={data.settings} />
        </div>
      ) : (
        <div className="stack">
          <TeamView data={data} highlights={hl.data} loading={q.loading} onOpen={setOpenId} />
          <TeamRevisionsCard month={month} tenantId={isGlobal ? tenant || null : null} onOpen={setOpenId} />
        </div>
      )}

      <Drawer open={!!openId} onClose={() => setOpenId(null)} wide
        title={data?.people.find((p) => p.id === openId)?.name ?? "Performance"} subtitle={monthLabel(month)}>
        {openId && data && <div className="stack"><PersonPerformance profileId={openId} month={month} settings={data.settings} /><PersonRevisions profileId={openId} month={month} /></div>}
      </Drawer>
    </div>
  );
}

function HighlightsSection({ data, onOpen }: { data: PerfHighlights | null | undefined; onOpen?: (id: string) => void }) {
  if (!data) return null;
  return (
    <Card title="Destaques do mês" count={data.items.length || undefined}>
      {data.items.length ? <HighlightsGrid items={data.items} onOpen={onOpen} /> : (
        <EmptyState compact icon="trophy" title="Sem destaques ainda neste mês."
          text={`O destaque de cada setor é quem tem a maior nota com pelo menos ${plural(data.settings.min_volume, "entrega prevista", "entregas previstas")}.`} />
      )}
    </Card>
  );
}

/* ---------- Visão da liderança ---------- */
type View = "ranking" | "matrix";

function TeamView({ data, highlights, loading, onOpen, onSector }: {
  data: PerfOverview; highlights: PerfHighlights | null | undefined; loading: boolean;
  onOpen: (id: string) => void;
}) {
  const mobile = useIsMobile();
  const [view, setView] = useState<View>("ranking");
  const [sector, setSector] = useState<string>("all");
  const s = data.settings;

  const sectorsInUse = useMemo(() => {
    const ids = new Set(data.people.map((p) => p.sector?.id ?? "none"));
    return [...data.sectors.filter((x) => ids.has(x.id)), ...(ids.has("none") ? [{ id: "none", name: "Sem setor" }] : [])];
  }, [data]);
  const people = data.people.filter((p) => sector === "all" || (p.sector?.id ?? "none") === sector);
  const scored = people.filter((p) => p.score != null);
  const sum = (k: "planned" | "delivered" | "on_time" | "late_open") => people.reduce((a, p) => a + p[k], 0);
  const avg = scored.length ? Math.round(scored.reduce((a, p) => a + (p.score ?? 0), 0) / scored.length) : null;
  const bandOf = (v: number | null) => (v == null ? null : v >= s.band_great ? "great" : v >= s.band_ok ? "ok" : "low");
  const delivered = sum("delivered"); const planned = sum("planned");

  return (
    <div className={cx("stack", loading && "is-loading")}>
      <div className="metrics">
        <MetricCard label="Nota média" value={avg ?? "—"} tone={avg == null ? "quiet" : bandOf(avg) === "low" ? "danger" : bandOf(avg) === "ok" ? "warning" : undefined}
          hint={avg == null ? "Sem entregas no período" : `${scored.length} ${scored.length === 1 ? "pessoa avaliada" : "pessoas avaliadas"}`} />
        <MetricCard label="Entregas" value={`${delivered}/${planned}`} hint={planned ? `${Math.round(Math.min(1, delivered / planned) * 100)}% do previsto` : "Nada previsto"} />
        <MetricCard label="No prazo" value={delivered ? `${Math.round((sum("on_time") / delivered) * 100)}%` : "—"} hint={`${sum("on_time")} de ${delivered} entregas`} />
        <MetricCard label="Em atraso" value={sum("late_open")} tone={sum("late_open") ? "danger" : "quiet"} hint="Itens vencidos em aberto" />
        <MetricCard label="Acima do esperado" value={scored.filter((p) => p.band === "great").length}
          hint={`${scored.filter((p) => p.band === "low").length} abaixo do esperado`} />
      </div>

      <HighlightsSection data={highlights} onOpen={onOpen} />

      <div className="pfilters">
        <Segmented<string> label="Setor" value={sector} onChange={setSector}
          options={[{ value: "all", label: "Todos" }, ...sectorsInUse.map((x) => ({ value: x.id, label: x.name }))]} />
        {!mobile && <Segmented<View> label="Visualização" value={view} onChange={setView}
          options={[{ value: "ranking", label: "Ranking" }, { value: "matrix", label: "Por atividade" }]} />}
      </div>
      <div className="plegend" aria-hidden="true">
        <span><i className="is-low" /> Abaixo do esperado (&lt; {s.band_ok})</span>
        <span><i className="is-ok" /> Satisfatório ({s.band_ok}–{s.band_great - 1})</span>
        <span><i className="is-great" /> Acima do esperado ({s.band_great}+)</span>
      </div>

      {people.length === 0 ? <Card><EmptyState icon="users" title="Ninguém neste filtro." /></Card> :
        view === "matrix" && !mobile ? <MatrixView people={people} /> : (
          (sector === "all" ? sectorsInUse : sectorsInUse.filter((x) => x.id === sector)).map((sec) => {
            const rows = people.filter((p) => (p.sector?.id ?? "none") === sec.id)
              .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.delivered - a.delivered || a.name.localeCompare(b.name));
            if (rows.length === 0) return null;
            return (
              <Card key={sec.id} title={sec.name} count={rows.length} flush>
                {sec.id === "none" && data.can_set_sector && (
                  <p className="subtext prank__hint">Sem setor, a pessoa fica fora do ranking e do destaque. O setor é definido na <Link to="/equipe" className="link">Equipe</Link>.</p>
                )}
                <ol className="prank">
                  {rows.map((p, i) => (
                    <RankRow key={p.id} row={p} pos={p.score != null && sec.id !== "none" ? i + 1 : null} trend={data.trend[p.id]}
                      onOpen={() => onOpen(p.id)} />
                  ))}
                </ol>
              </Card>
            );
          })
        )}
      <ScoreExplain settings={s} />
    </div>
  );
}

function RankRow({ row: p, pos, trend, onOpen }: {
  row: PerfRow; pos: number | null; trend: PerfOverview["trend"][string] | undefined; onOpen: () => void;
}) {
  return (
    <li className={cx("prow", p.band && `is-${p.band}`)}>
      <span className={cx("prow__pos", pos === 1 && "is-first")}>{pos ?? "–"}</span>
      <button type="button" className="prow__who" onClick={onOpen}>
        <Avatar name={p.name} src={p.avatar_url} size="sm" />
        <span className="prow__name">{p.name}</span>
        {p.employment_type === "pj" && <Badge tag outline>PJ</Badge>}
      </button>
      <span className="prow__score">
        <b>{p.score ?? "—"}</b>
        <span className="prow__bar"><i style={{ width: `${Math.min(100, p.score ?? 0)}%` }} /></span>
      </span>
      <span className="prow__stats">
        <span title="Entregas feitas / previstas"><b>{p.delivered}</b>/{p.planned} entregas</span>
        <span title="Entregas no prazo">{p.on_time_pct == null ? "—" : `${p.on_time_pct}%`} no prazo</span>
        <span className={cx(p.late_open > 0 && "is-danger")}>{p.late_open} em atraso</span>
      </span>
      <span className="prow__trend"><TrendBars points={trend} compact /></span>
      <span className="prow__band"><BandPill band={p.band} /></span>
    </li>
  );
}

/** Matriz entregues/previstas por atividade e pessoa (como as planilhas, mas automática). */
function MatrixView({ people }: { people: PerfRow[] }) {
  const acts = useMemo(() => {
    const m = new Map<string, { key: string; label: string; is_task: boolean }>();
    people.forEach((p) => p.activities.forEach((a) => { if (!m.has(a.key)) m.set(a.key, { key: a.key, label: a.label, is_task: a.is_task }); }));
    return [...m.values()].sort((a, b) => Number(a.is_task) - Number(b.is_task) || a.label.localeCompare(b.label));
  }, [people]);
  if (acts.length === 0) return <Card><EmptyState title="Nenhuma entrega prevista neste mês." /></Card>;
  return (
    <Card flush>
      <div className="pmatrix-wrap">
        <table className="pmatrix">
          <thead>
            <tr><th>Atividade</th>{people.map((p) => (
              <th key={p.id}><span className="pmatrix__who"><Avatar name={p.name} src={p.avatar_url} size="sm" />{p.name.split(" ")[0]}</span></th>
            ))}</tr>
          </thead>
          <tbody>
            {acts.map((a) => (
              <tr key={a.key}>
                <th scope="row">{a.label}</th>
                {people.map((p) => {
                  const x = p.activities.find((y) => y.key === a.key);
                  if (!x || (x.planned === 0 && x.delivered === 0)) return <td key={p.id} className="is-empty">–</td>;
                  return <td key={p.id} className={x.delivered < x.planned ? "is-low" : "is-great"}>{x.delivered}/{x.planned}</td>;
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><th scope="row">Total</th>{people.map((p) => <td key={p.id}><b>{p.delivered}/{p.planned}</b></td>)}</tr>
            <tr><th scope="row">Nota</th>{people.map((p) => <td key={p.id} className={cx("pmatrix__score", p.band && `is-${p.band}`)}>{p.score ?? "—"}</td>)}</tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
