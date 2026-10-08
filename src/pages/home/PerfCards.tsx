import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { Link, useNavigate } from "@/lib/router";
import { Card, EmptyState } from "@/components/ui/primitives";
import type { PerfHighlights, PerfRow, PerfSettings } from "@/types/domain";
import { plural } from "@/utils/format";
import { todayISO } from "@/pages/schedule/model";
import { BandPill, HighlightsGrid, monthLabel, monthOf, ScoreRing, shiftMonth } from "@/pages/performance/perfUi";

/* ==========================================================================
   Página inicial: destaques por setor e "minha performance" (CLT)
   ========================================================================== */

/** Destaques do mês; no começo do mês, sem destaques ainda, mostra o mês anterior. */
export function HighlightsCard({ isManager }: { isManager: boolean }) {
  const navigate = useNavigate();
  const [data, setData] = useState<PerfHighlights | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const cur = monthOf(todayISO());
    api.performanceHighlights(cur).then(async (h) => {
      if (h && h.items.length === 0) {
        const prev = await api.performanceHighlights(shiftMonth(cur, -1)).catch(() => null);
        if (prev && prev.items.length > 0) { if (live) setData(prev); return; }
      }
      if (live) setData(h);
    }).catch(() => live && setData(null));
    return () => { live = false; };
  }, []);
  if (!data) return null; // sem permissão (PJ) ou carregando
  const current = data.month === monthOf(todayISO());
  return (
    <Card title={`Destaques de ${monthLabel(data.month).split(" ")[0].toLowerCase()}${current ? " (parcial)" : ""}`}
      action={isManager ? <Link to="/performance" className="link">Ver performance</Link> : undefined}>
      {data.items.length ? (
        <HighlightsGrid items={data.items} onOpen={isManager ? () => navigate("/performance") : undefined} />
      ) : (
        <EmptyState compact icon="trophy" title="Sem destaques ainda."
          text={isManager ? "Defina o setor de cada pessoa em Performance. O destaque é a maior nota do setor no mês."
            : `O destaque de cada setor é quem tem a maior nota com pelo menos ${plural(data.settings.min_volume, "entrega prevista", "entregas previstas")}.`} />
      )}
    </Card>
  );
}

/** Minha performance no mês (só para quem pode ver a própria: CLT). */
export function MyPerformanceCard() {
  const [row, setRow] = useState<{ p: PerfRow; s: PerfSettings; month: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.performanceOverview(monthOf(todayISO())).then((o) => {
      const me = o.scope === "self" ? o.people[0] : null;
      if (live && me) setRow({ p: me, s: o.settings, month: o.month });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (!row) return null;
  const { p } = row;
  return (
    <Card title="Minha performance" action={<Link to="/performance" className="link">Detalhes</Link>}>
      <div className="hperf">
        <ScoreRing score={p.score} band={p.band} size={96} />
        <div className="hperf__text">
          <BandPill band={p.band} />
          <span className="subtext">{monthLabel(row.month)} · parcial até hoje</span>
          <span className="hperf__nums">
            <span><b>{p.delivered}</b>/{p.planned} entregas</span>
            <span><b>{p.on_time_pct ?? "—"}{p.on_time_pct != null && "%"}</b> no prazo</span>
            {p.late_open > 0 && <span className="is-danger"><b>{p.late_open}</b> em atraso</span>}
          </span>
        </div>
      </div>
    </Card>
  );
}
