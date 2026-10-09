import { useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Card, EmptyState, LoadError, MetricCard, SearchInput, Segmented, Select, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate, plural } from "@/utils/format";
import { normName } from "@/components/ui/StepPicker";
import type { NpsCategory, NpsOverview } from "@/types/domain";

/* ==========================================================================
   NPS: indicadores e respostas dos clientes (aba Customer Success)
   ========================================================================== */
type Period = "30" | "90" | "365" | "all";
const PERIODS: { value: Period; label: string }[] = [
  { value: "30", label: "30 dias" }, { value: "90", label: "90 dias" }, { value: "365", label: "12 meses" }, { value: "all", label: "Tudo" },
];
const CAT: Record<NpsCategory, { label: string; cls: string }> = {
  promoter: { label: "Promotor", cls: "is-high" }, passive: { label: "Neutro", cls: "is-mid" }, detractor: { label: "Detrator", cls: "is-low" },
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const npsZone = (n: number | null) =>
  n == null ? "Sem respostas" : n >= 75 ? "Excelência" : n >= 50 ? "Qualidade" : n >= 0 ? "Aperfeiçoamento" : "Crítica";
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

export function NpsPanel() {
  const [period, setPeriod] = useState<Period>("90");
  const range = useMemo(() => {
    if (period === "all") return { from: "2000-01-01", to: iso(new Date()) };
    const d = new Date(); d.setDate(d.getDate() - Number(period) + 1);
    return { from: iso(d), to: iso(new Date()) };
  }, [period]);
  const ov = useAsync(() => api.npsOverview(range.from, range.to), [range.from, range.to]);
  const list = useAsync(() => api.npsResponses(range.from, range.to), [range.from, range.to]);
  const [cat, setCat] = useState<"" | NpsCategory>("");
  const [service, setService] = useState("");
  const [q, setQ] = useState("");
  const [onlyComments, setOnlyComments] = useState(false);

  const rows = list.data ?? [];
  const services = useMemo(() => [...new Set(rows.map((r) => r.service_name))].sort(), [rows]);
  const s = normName(q);
  const shown = rows.filter((r) => (!cat || r.category === cat) && (!service || r.service_name === service) && (!onlyComments || !!r.comment)
    && (!s || normName(`${r.comment ?? ""} ${r.project_name} ${r.client_name ?? ""} ${r.respondent}`).includes(s)));

  if (ov.error) return <LoadError message={ov.error} onRetry={() => void ov.reload()} />;
  const o = ov.data;

  return (
    <div className="npsp">
      <div className="npsp__bar">
        <Segmented<Period> label="Período" value={period} onChange={setPeriod} options={PERIODS} />
        <span className="subtext">Pesquisa enviada ao cliente quando um serviço tem todas as etapas concluídas.</span>
      </div>

      {!o ? <Skeleton height={140} radius={16} /> : (
        <>
          <div className="npsp__top">
            <ScoreCard o={o} />
            <div className="metrics npsp__metrics">
              <MetricCard label="Respostas" value={o.responses} hint={o.avg_score != null ? `Nota média ${String(o.avg_score).replace(".", ",")}` : "Nenhuma no período"} />
              <MetricCard label="Taxa de resposta" value={o.completed_services ? `${Math.round((100 * o.answered_services) / o.completed_services)}%` : "—"}
                hint={o.completed_services ? `${o.answered_services} de ${plural(o.completed_services, "serviço concluído", "serviços concluídos")}` : "Nenhum serviço concluído"} />
              <MetricCard label="Aguardando resposta" value={o.pending_services} hint="Serviços concluídos sem avaliação" tone={o.pending_services ? "warning" : "quiet"} />
              <MetricCard label="Detratores" value={o.detractors} tone={o.detractors ? "danger" : "quiet"} hint="Notas de 0 a 6"
                onClick={o.detractors ? () => setCat("detractor") : undefined} />
            </div>
          </div>

          <div className="npsp__grid">
            <Card title="Distribuição das notas">
              <Distribution d={o.distribution} />
            </Card>
            <Card title="NPS por mês" action={<span className="subtext">últimos 6 meses</span>}>
              <ul className="npsm">
                {o.by_month.map((m) => {
                  const [y, mm] = m.month.slice(0, 7).split("-");
                  return (
                    <li key={m.month}>
                      <span className="npsm__m">{MONTHS[Number(mm) - 1]}/{y.slice(2)}</span>
                      <span className="npsm__track" aria-hidden="true">
                        <span className="npsm__zero" />
                        {m.nps != null && <span className={cx("npsm__bar", m.nps < 0 && "is-neg")}
                          style={m.nps >= 0 ? { left: "50%", width: `${m.nps / 2}%` } : { right: "50%", width: `${-m.nps / 2}%` }} />}
                      </span>
                      <span className="npsm__v num">{m.nps != null ? m.nps : "—"}</span>
                      <span className="npsm__n">{m.responses ? plural(m.responses, "resposta", "respostas") : "sem respostas"}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>

          {o.by_service.length > 0 && (
            <Card title="NPS por serviço" flush>
              <div className="npss" role="table" aria-label="NPS por serviço">
                <div className="npss__row npss__row--head" role="row">
                  <span role="columnheader">Serviço</span><span role="columnheader">Respostas</span><span role="columnheader">Nota média</span><span role="columnheader">NPS</span>
                </div>
                {o.by_service.map((x) => (
                  <div key={x.service} className="npss__row" role="row">
                    <span role="cell">{x.service}</span>
                    <span role="cell" className="num">{x.responses}</span>
                    <span role="cell" className="num">{String(x.avg_score).replace(".", ",")}</span>
                    <span role="cell" className={cx("num npss__nps", x.nps >= 50 ? "is-high" : x.nps >= 0 ? "is-mid" : "is-low")}>{x.nps}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Card title="Respostas dos clientes" count={shown.length || undefined} flush>
        <div className="npsr__filters">
          <SearchInput aria-label="Buscar nas respostas" placeholder="Comentário, projeto ou cliente" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select aria-label="Categoria" value={cat} onChange={(e) => setCat(e.target.value as typeof cat)}>
            <option value="">Todas as notas</option>
            <option value="promoter">Promotores (9-10)</option>
            <option value="passive">Neutros (7-8)</option>
            <option value="detractor">Detratores (0-6)</option>
          </Select>
          <Select aria-label="Serviço" value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">Todos os serviços</option>
            {services.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
          <label className="npsr__chk"><input type="checkbox" checked={onlyComments} onChange={(e) => setOnlyComments(e.target.checked)} /> Só com comentário</label>
        </div>
        {list.error ? <div className="settings__pad"><LoadError message={list.error} onRetry={() => void list.reload()} /></div>
          : list.loading && !list.data ? <div className="settings__pad"><Skeleton height={120} radius={12} /></div>
          : shown.length === 0 ? <EmptyState compact icon="trophy" title={rows.length ? "Nenhuma resposta com esses filtros." : "Nenhuma resposta no período."}
              text={rows.length ? undefined : "Quando um cliente avaliar um serviço concluído, a resposta aparece aqui."} />
          : (
            <ul className="npsr">
              {shown.map((r) => (
                <li key={r.id} className="npsr__item">
                  <span className={cx("npsr__score", CAT[r.category].cls)} title={CAT[r.category].label}>{r.score}</span>
                  <div className="grow">
                    <div className="npsr__head">
                      <b>{r.client_name ?? r.respondent}</b>
                      <span className={cx("npsr__cat", CAT[r.category].cls)}>{CAT[r.category].label}</span>
                      <span className="subtext">{formatDate(r.answered_at, true)}</span>
                    </div>
                    <span className="npsr__meta">
                      {r.service_name} · <Link to={`/projetos/${r.project_id}`} className="link">{r.project_name}</Link>
                      {r.respondent !== r.client_name ? ` · respondido por ${r.respondent}` : ""}{r.tenant_name ? ` · ${r.tenant_name}` : ""}
                    </span>
                    {r.comment ? <p className="npsr__comment">“{r.comment}”</p> : <p className="npsr__none">Sem comentário</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  );
}

function ScoreCard({ o }: { o: NpsOverview }) {
  const total = o.responses || 1;
  const pct = (n: number) => Math.round((100 * n) / total);
  const delta = o.nps != null && o.prev_nps != null ? o.nps - o.prev_nps : null;
  return (
    <div className="npsc">
      <span className="label">NPS do período</span>
      <div className="npsc__main">
        <span className={cx("npsc__value", o.nps == null ? "" : o.nps >= 50 ? "is-high" : o.nps >= 0 ? "is-mid" : "is-low")}>{o.nps ?? "—"}</span>
        <span className="npsc__zone">
          <b>{npsZone(o.nps)}</b>
          {delta != null && <span className={cx("npsc__delta", delta >= 0 ? "is-up" : "is-down")}>
            <Icon name={delta >= 0 ? "trend" : "chevronDown"} size={13} /> {delta > 0 ? "+" : ""}{delta} vs. período anterior</span>}
        </span>
      </div>
      {o.responses > 0 && (
        <>
          <div className="npsc__stack" role="img" aria-label={`${pct(o.promoters)}% promotores, ${pct(o.passives)}% neutros, ${pct(o.detractors)}% detratores`}>
            {o.detractors > 0 && <span className="is-low" style={{ flexGrow: o.detractors }} />}
            {o.passives > 0 && <span className="is-mid" style={{ flexGrow: o.passives }} />}
            {o.promoters > 0 && <span className="is-high" style={{ flexGrow: o.promoters }} />}
          </div>
          <div className="npsc__legend">
            <span><i className="is-low" />Detratores {pct(o.detractors)}%</span>
            <span><i className="is-mid" />Neutros {pct(o.passives)}%</span>
            <span><i className="is-high" />Promotores {pct(o.promoters)}%</span>
          </div>
        </>
      )}
      <span className="npsc__formula">NPS = % promotores (9-10) − % detratores (0-6)</span>
    </div>
  );
}

function Distribution({ d }: { d: number[] }) {
  const max = Math.max(1, ...d);
  const total = d.reduce((a, b) => a + b, 0);
  if (!total) return <p className="subtext">Nenhuma nota no período.</p>;
  return (
    <div className="npsd" role="img" aria-label={`Notas: ${d.map((n, i) => `${i}: ${n}`).join(", ")}`}>
      {d.map((n, i) => (
        <div key={i} className="npsd__col" title={`Nota ${i}: ${plural(n, "resposta", "respostas")}`}>
          <span className="npsd__val">{n || ""}</span>
          <span className={cx("npsd__bar", i <= 6 ? "is-low" : i <= 8 ? "is-mid" : "is-high")} data-empty={!n || undefined}
            style={{ height: `${n ? Math.max(6, (n / max) * 100) : 2}%` }} />
          <span className="npsd__lbl">{i}</span>
        </div>
      ))}
    </div>
  );
}
