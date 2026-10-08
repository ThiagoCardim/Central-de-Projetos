import { useMemo } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { useNavigate } from "@/lib/router";
import { Avatar, Badge, Card, EmptyState, LoadError, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import type { PerfBand, PerfHighlight, PerfItem, PerfRow, PerfSettings, PerfTrendPoint } from "@/types/domain";
import { cx, formatDate, plural } from "@/utils/format";

/* ==========================================================================
   Peças visuais da performance (página, gaveta e página inicial)
   ========================================================================== */
export const BAND_LABEL: Record<PerfBand, string> = { low: "Abaixo do esperado", ok: "Satisfatório", great: "Acima do esperado" };
const MONTH_FMT = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
const MONTH_SHORT = new Intl.DateTimeFormat("pt-BR", { month: "short" });
const parse = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d || 1); };
const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const monthLabel = (iso: string) => { const s = MONTH_FMT.format(parse(iso)); return s.charAt(0).toUpperCase() + s.slice(1); };
export const shiftMonth = (iso: string, n: number) => { const d = parse(iso); d.setDate(1); d.setMonth(d.getMonth() + n); return toIso(d); };
export const monthOf = (iso: string) => iso.slice(0, 8) + "01";

export function BandPill({ band, score }: { band: PerfBand | null; score?: number | null }) {
  if (!band) return <span className="pband is-none">Sem entregas</span>;
  return <span className={cx("pband", `is-${band}`)}>{score != null && <b>{score}</b>}{BAND_LABEL[band]}</span>;
}

/** Anel da nota (0–100). */
export function ScoreRing({ score, band, size = 112, label = "Nota" }: { score: number | null; band: PerfBand | null; size?: number; label?: string }) {
  const r = 42; const c = 2 * Math.PI * r;
  const v = score == null ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className={cx("pring", band ? `is-${band}` : "is-none")} style={{ width: size, height: size }} role="img"
      aria-label={score == null ? `${label}: sem entregas no período` : `${label}: ${score} de 100, ${BAND_LABEL[band!]}`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="pring__track" />
        <circle cx="50" cy="50" r={r} className="pring__value" strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 50 50)" />
      </svg>
      <span className="pring__text"><b>{score ?? "—"}</b><small>{label}</small></span>
    </div>
  );
}

/** Barras de evolução (últimos meses). */
export function TrendBars({ points, compact }: { points: PerfTrendPoint[] | null | undefined; compact?: boolean }) {
  const pts = points ?? [];
  if (pts.length === 0) return null;
  return (
    <div className={cx("ptrend", compact && "is-compact")} role="img"
      aria-label={`Evolução: ${pts.map((p) => `${MONTH_SHORT.format(parse(p.month))} ${p.score ?? "sem dados"}`).join(", ")}`}>
      {pts.map((p) => (
        <span key={p.month} className="ptrend__col" title={`${monthLabel(p.month)}: ${p.score ?? "sem entregas"}`}>
          <span className="ptrend__bar"><i className={cx(p.band ? `is-${p.band}` : "is-none")} style={{ height: `${Math.max(4, Math.min(100, p.score ?? 0))}%` }} /></span>
          {!compact && <span className="ptrend__lbl">{MONTH_SHORT.format(parse(p.month)).replace(".", "")}</span>}
          {!compact && <span className="ptrend__val">{p.score ?? "—"}</span>}
        </span>
      ))}
    </div>
  );
}

/** Componentes da nota, com os pesos da unidade. */
export function ScoreParts({ row, settings }: { row: PerfRow; settings: PerfSettings }) {
  const parts = [
    { key: "c", label: "Cumprimento", hint: `${row.delivered} de ${plural(row.planned, "entrega prevista", "entregas previstas")}`, pct: row.delivery_pct, w: settings.weight_delivery },
    { key: "t", label: "Pontualidade", hint: row.delivered ? `${row.on_time} de ${row.delivered} no prazo${row.late_days_avg ? ` · atraso médio ${row.late_days_avg} d` : ""}` : "Nenhuma entrega no período", pct: row.on_time_pct, w: settings.weight_on_time },
    { key: "b", label: "Sem atrasos em aberto", hint: row.late_open ? `${plural(row.late_open, "item vencido", "itens vencidos")} em aberto` : "Nada vencido em aberto", pct: row.no_backlog_pct, w: settings.weight_no_backlog },
  ].filter((p) => p.w > 0);
  return (
    <div className="pparts">
      {parts.map((p) => (
        <div key={p.key} className="ppart">
          <div className="ppart__head"><span>{p.label}</span><b>{p.pct == null ? "—" : `${p.pct}%`}</b></div>
          <span className="ppart__bar"><i className={cx(p.pct == null ? "is-none" : p.pct >= settings.band_great ? "is-great" : p.pct >= settings.band_ok ? "is-ok" : "is-low")}
            style={{ width: `${p.pct ?? 0}%` }} /></span>
          <span className="ppart__hint">{p.hint} · peso {p.w}%</span>
        </div>
      ))}
    </div>
  );
}

/** Explicação curta da nota. */
export function ScoreExplain({ settings }: { settings: PerfSettings }) {
  return (
    <details className="pexplain">
      <summary><Icon name="alertCircle" size={14} /> Como a nota é calculada</summary>
      <p>Contam as <b>etapas dos projetos</b> sob responsabilidade da pessoa{settings.include_assigned_tasks ? <> e as <b>tarefas atribuídas pela liderança</b></> : null}.
        Tarefas que a pessoa cria para si não contam.</p>
      <ul>
        <li><b>Cumprimento</b> ({settings.weight_delivery}%): entregas feitas no mês ÷ entregas previstas no mês.</li>
        <li><b>Pontualidade</b> ({settings.weight_on_time}%): entregas feitas até o prazo ÷ entregas feitas.</li>
        <li><b>Sem atrasos em aberto</b> ({settings.weight_no_backlog}%): quanto menos itens vencidos e não entregues, maior.</li>
      </ul>
      <p>Faixas: abaixo de {settings.band_ok} = abaixo do esperado · {settings.band_ok} a {settings.band_great - 1} = satisfatório · {settings.band_great} ou mais = acima do esperado.
        No mês em andamento, conta o que venceu até hoje.</p>
    </details>
  );
}

/** Detalhe da performance de uma pessoa no mês. */
export function PersonPerformance({ profileId, month, settings, self }: { profileId: string; month: string; settings: PerfSettings; self?: boolean }) {
  const navigate = useNavigate();
  const q = useAsync(() => api.performancePerson(profileId, month), [profileId, month]);
  const acts = useMemo(() => q.data?.person.activities ?? [], [q.data]);
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <div className="stack"><Skeleton height={140} radius={16} /><Skeleton height={220} radius={16} /></div>;
  const { person: p, late, delivered, trend } = q.data;
  const open = (it: PerfItem) => {
    if (it.kind === "step" && it.project_id) navigate(`/projetos/${it.project_id}/cronograma?etapa=${it.id}`);
    else navigate(self ? "/minhas-tarefas" : "/minhas-tarefas?aba=equipe");
  };

  return (
    <div className="pperson stack">
      <section className="pperson__hero">
        <ScoreRing score={p.score} band={p.band} size={128} />
        <div className="pperson__who">
          <span className="pperson__name">
            <Avatar name={p.name} src={p.avatar_url} size="sm" /> <strong>{p.name}</strong>
            {p.employment_type === "pj" && <Badge tag outline>PJ</Badge>}
          </span>
          <span className="subtext">{p.sector?.name ?? "Sem setor"} · {monthLabel(q.data.month)}</span>
          <BandPill band={p.band} />
          <div className="pperson__nums">
            <span><b>{p.delivered}</b>/{p.planned} entregas</span>
            <span><b>{p.on_time_pct ?? "—"}{p.on_time_pct != null && "%"}</b> no prazo</span>
            <span className={cx(p.late_open > 0 && "is-danger")}><b>{p.late_open}</b> em atraso</span>
          </div>
        </div>
        <div className="pperson__trend">
          <span className="label">Últimos 6 meses</span>
          <TrendBars points={trend} />
        </div>
      </section>

      <ScoreParts row={p} settings={settings} />

      <div className="pperson__grid">
        <Card title="Por atividade" flush>
          {acts.length === 0 ? <EmptyState compact title="Nenhuma entrega prevista neste mês." /> : (
            <table className="ptable">
              <thead><tr><th>Atividade</th><th>Previstas</th><th>Entregues</th><th>No prazo</th></tr></thead>
              <tbody>
                {acts.map((a) => (
                  <tr key={a.key}>
                    <td><span className="ptable__act">{a.is_task && <Icon name="user" size={12} />}{a.label}</span></td>
                    <td className="num">{a.planned}</td>
                    <td className={cx("num", a.delivered < a.planned ? "is-low" : "is-great")}>{a.delivered}</td>
                    <td className="num">{a.delivered ? `${Math.round((a.on_time / a.delivered) * 100)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Em atraso agora" count={late.length || undefined} flush>
          {late.length === 0 ? <EmptyState compact icon="checkCircle" title="Nada em atraso." /> : (
            <ul className="plist">
              {late.slice(0, 12).map((it) => (
                <li key={`${it.kind}${it.id}`}>
                  <button type="button" className="plist__item" onClick={() => open(it)}>
                    <span className="plist__title">{it.title}</span>
                    <span className="plist__meta">{it.kind === "task" ? "Tarefa da liderança" : it.project} · prazo {formatDate(it.due)}</span>
                  </button>
                  <span className="mw-dl is-danger">{plural(it.days ?? 0, "dia", "dias")}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Entregas do mês" count={delivered.length || undefined} flush>
        {delivered.length === 0 ? <EmptyState compact title="Nenhuma entrega registrada neste mês ainda." /> : (
          <ul className="plist">
            {delivered.slice(0, 30).map((it) => (
              <li key={`${it.kind}${it.id}`}>
                <button type="button" className="plist__item" onClick={() => open(it)}>
                  <span className="plist__title">{it.title}</span>
                  <span className="plist__meta">{it.kind === "task" ? "Tarefa da liderança" : it.project} · entregue {formatDate(it.done ?? null)} · prazo {formatDate(it.due)}</span>
                </button>
                {(it.late_days ?? 0) > 0
                  ? <span className="mw-dl is-warning">{plural(it.late_days!, "dia", "dias")} de atraso</span>
                  : <span className="mw-dl is-success">No prazo</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Destaques do mês por setor. */
export function HighlightsGrid({ items, onOpen }: { items: PerfHighlight[]; onOpen?: (id: string) => void }) {
  return (
    <div className="phl">
      {items.map((h) => (
        <button key={h.sector.id} type="button" className={cx("phl__card", `is-${h.band}`)} onClick={() => onOpen?.(h.person.id)} disabled={!onOpen}>
          <span className="phl__sector"><Icon name="trophy" size={14} /> {h.sector.name}</span>
          <span className="phl__person">
            <Avatar name={h.person.name} src={h.person.avatar_url} size="lg" />
            <span className="phl__name">{h.person.name}</span>
          </span>
          <span className="phl__score"><b>{h.score}</b><BandPill band={h.band} /></span>
          <span className="phl__meta">{plural(h.delivered, "entrega", "entregas")}{h.on_time_pct != null ? ` · ${h.on_time_pct}% no prazo` : ""}</span>
        </button>
      ))}
    </div>
  );
}
