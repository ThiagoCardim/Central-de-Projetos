import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Avatar, Badge, Card, EmptyState, MetricCard, Skeleton } from "@/components/ui/primitives";
import { cx, formatDate, plural } from "@/utils/format";
import type { RevisionsPersonRow } from "@/types/domain";

/* ==========================================================================
   Indicador de revisões: quantas rodadas os clientes pediram sobre as versões
   de cada pessoa (responsável pela criação). Mesma visibilidade da Performance.
   ========================================================================== */
const avgOf = (r: RevisionsPersonRow) => (r.approved ? r.approved_rounds / r.approved : null);
const fmt1 = (n: number | null) => (n == null ? "—" : n.toFixed(1).replace(".", ","));

export function TeamRevisionsCard({ month, tenantId, onOpen }: { month: string; tenantId: string | null; onOpen?: (id: string) => void }) {
  const q = useAsync(() => api.revisionsOverview(month, tenantId), [month, tenantId]);
  if (q.error) return null;
  if (!q.data) return <Skeleton height={160} radius={16} />;
  const rows = q.data.people.filter((p) => p.presentations + p.revisions + p.approved + p.courtesy + p.paid > 0);
  const active = rows.filter((p) => p.revisions > 0 || p.presentations > 0);
  const teamAvg = active.length ? active.reduce((a, p) => a + p.revisions, 0) / active.length : 0;
  const total = rows.reduce((a, p) => a + p.revisions, 0);

  return (
    <Card title="Revisões pedidas pelos clientes" count={total || undefined} flush
      action={<span className="subtext">{teamAvg ? `média do time: ${fmt1(teamAvg)} por pessoa` : "no mês"}</span>}>
      {rows.length === 0 ? <EmptyState compact icon="layers" title="Nenhuma apresentação ou revisão no mês." text="Os números aparecem quando a equipe publica entregas e os clientes pedem revisões." /> : (
        <div className="revt" role="table" aria-label="Revisões por pessoa">
          <div className="revt__row revt__row--head" role="row">
            <span role="columnheader">Pessoa</span><span role="columnheader">Apresentações</span><span role="columnheader">Revisões</span>
            <span role="columnheader">Média até aprovar</span><span role="columnheader">Extras</span>
          </div>
          {rows.map((p) => {
            const high = p.revisions >= 3 && teamAvg > 0 && p.revisions >= teamAvg * 1.5;
            return (
              <button key={p.id} type="button" className={cx("revt__row", high && "is-high")} role="row" onClick={() => onOpen?.(p.id)} disabled={!onOpen}>
                <span role="cell" className="revt__who"><Avatar name={p.name} src={p.avatar_url} size="sm" /> {p.name}</span>
                <span role="cell" className="num">{p.presentations}</span>
                <span role="cell" className="num revt__rev">{p.revisions}{high && <Badge tone="warning">Acima da média</Badge>}</span>
                <span role="cell" className="num" title={p.approved ? plural(p.approved, "projeto aprovado no mês", "projetos aprovados no mês") : undefined}>{fmt1(avgOf(p))}</span>
                <span role="cell" className="num">{p.courtesy + p.paid ? `${p.courtesy} cortesia · ${p.paid} paga` : "—"}</span>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function PersonRevisions({ profileId, month, self }: { profileId: string; month: string; self?: boolean }) {
  const ov = useAsync(() => (self ? api.revisionsOverview(month, null) : Promise.resolve(null)), [month, self]);
  const q = useAsync(() => api.revisionsPerson(profileId, month), [profileId, month]);
  const me = ov.data?.people.find((p) => p.id === profileId);
  if (q.error) return null;
  return (
    <div className="stack">
      {self && me && (
        <div className="metrics">
          <MetricCard label="Apresentações" value={me.presentations} hint="Publicadas no mês" />
          <MetricCard label="Revisões pedidas" value={me.revisions} tone={me.revisions ? "warning" : "quiet"} hint="Sobre versões suas" />
          <MetricCard label="Média até aprovar" value={fmt1(avgOf(me))} hint={me.approved ? plural(me.approved, "projeto aprovado", "projetos aprovados") : "Nenhuma aprovação no mês"} />
          <MetricCard label="Revisões extras" value={me.courtesy + me.paid} hint={`${me.courtesy} cortesia · ${me.paid} paga`} />
        </div>
      )}
      <Card title={self ? "Minhas revisões no mês" : "Revisões no mês"} count={q.data?.length || undefined} flush>
        {!q.data ? <div className="settings__pad"><Skeleton height={60} radius={10} /></div>
          : q.data.length === 0 ? <EmptyState compact icon="checkCircle" title="Nenhuma revisão pedida no mês." />
          : (
            <ul className="revl">
              {q.data.map((r) => (
                <li key={r.id}>
                  <span className="revl__round">R{r.round}</span>
                  <div className="grow">
                    <Link to={`/projetos/${r.project_id}/entregas`} className="link">{r.project_name}</Link>
                    <span className="subtext"> · {r.service} · {plural(r.items, "alteração", "alterações")}{r.on_behalf ? " · registrada pela equipe" : ""}</span>
                  </div>
                  <span className="subtext">{formatDate(r.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
      </Card>
    </div>
  );
}
