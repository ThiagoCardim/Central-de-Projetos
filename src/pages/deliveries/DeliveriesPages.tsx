import { useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useParams, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { Card, EmptyState, LoadError, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/utils/format";
import { DeliveriesView } from "./Deliveries";

/* Equipe: entregas de um projeto (/projetos/:id/entregas) */
export function ProjectDeliveriesPage() {
  const { id } = useParams();
  const servico = useSearchParam("servico");
  const p = useAsync(() => api.getProject(id ?? ""), [id]);
  useDocumentTitle(p.data ? `Entregas · ${p.data.name}` : "Entregas");
  const people = useMemo(() => {
    const m = new Map<string, string>();
    (p.data?.team ?? []).filter((t) => t.active && t.user).forEach((t) => m.set(t.user!.id, t.user!.name));
    return [...m.entries()].map(([pid, name]) => ({ id: pid, name }));
  }, [p.data]);

  if (p.error) return <div className="page"><LoadError message={p.error} onRetry={() => void p.reload()} /></div>;
  return (
    <div className="page">
      <nav className="crumbs" aria-label="Você está em">
        <Link to="/projetos">Projetos</Link><Icon name="chevronRight" size={14} />
        {p.data ? <Link to={`/projetos/${p.data.id}`}>{p.data.code ?? p.data.name}</Link> : <span>…</span>}
        <Icon name="chevronRight" size={14} /><span>Entregas</span>
      </nav>
      <PageHead title="Entregas e revisões" subtitle={p.data ? `${p.data.name}${p.data.client ? ` · ${p.data.client.name}` : ""}` : undefined}
        actions={p.data && <Link to={`/projetos/${p.data.id}/cronograma`} className="btn btn--secondary"><Icon name="calendar" /> Cronograma</Link>} />
      {!p.data ? <Skeleton height={420} radius={16} /> : <DeliveriesView projectId={p.data.id} people={people} initialKey={servico} />}
    </div>
  );
}

/* Cliente: entregas dos seus projetos (/entregas) */
export function ClientDeliveriesPage() {
  useDocumentTitle("Entregas");
  const wanted = useSearchParam("projeto");
  const q = useAsync(() => api.deliveryProjects(), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = q.data ?? [];
  const current = list.find((x) => x.id === (chosen ?? wanted)) ?? list[0];

  return (
    <div className="page">
      <PageHead title="Entregas" subtitle="Os arquivos do seu projeto, organizados por serviço. Aqui você aprova cada etapa ou pede revisão." />
      {q.error ? <LoadError message={q.error} onRetry={() => void q.reload()} />
        : !q.data ? <Skeleton height={420} radius={16} />
        : list.length === 0 ? <Card><EmptyState icon="folder" title="Você ainda não tem projeto em andamento." /></Card>
        : (
          <>
            {list.length > 1 && (
              <div className="chips dlvprojects" role="group" aria-label="Projeto">
                {list.map((x) => (
                  <button key={x.id} type="button" className={cx("chip")} aria-pressed={x.id === current.id} onClick={() => setChosen(x.id)}>
                    {x.name}{x.awaiting_client > 0 && <span className="chip__n">{x.awaiting_client}</span>}
                  </button>
                ))}
              </div>
            )}
            <DeliveriesView key={current.id} projectId={current.id} />
          </>
        )}
    </div>
  );
}
