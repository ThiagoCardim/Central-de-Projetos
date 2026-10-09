import { useState } from "react";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useParams, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { Card, EmptyState, LoadError, Skeleton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/utils/format";
import { DocumentsView } from "./Documents";

/* Equipe: documentos do cliente de um projeto (/projetos/:id/documentos) */
export function ProjectDocumentsPage() {
  const { id } = useParams();
  const p = useAsync(() => api.getProject(id ?? ""), [id]);
  useDocumentTitle(p.data ? `Documentos · ${p.data.name}` : "Documentos");
  if (p.error) return <div className="page"><LoadError message={p.error} onRetry={() => void p.reload()} /></div>;
  return (
    <div className="page">
      <nav className="crumbs" aria-label="Você está em">
        <Link to="/projetos">Projetos</Link><Icon name="chevronRight" size={14} />
        {p.data ? <Link to={`/projetos/${p.data.id}`}>{p.data.code ?? p.data.name}</Link> : <span>…</span>}
        <Icon name="chevronRight" size={14} /><span>Documentos do cliente</span>
      </nav>
      <PageHead title="Documentos do cliente" subtitle={p.data ? `${p.data.name}${p.data.client ? ` · ${p.data.client.name}` : ""}` : undefined}
        actions={p.data && <Link to={`/projetos/${p.data.id}/entregas`} className="btn btn--secondary"><Icon name="layers" /> Entregas</Link>} />
      {!p.data ? <Skeleton height={420} radius={16} /> : <DocumentsView projectId={p.data.id} />}
    </div>
  );
}

/* Cliente: documentos dos seus projetos (/documentos) */
export function ClientDocumentsPage() {
  useDocumentTitle("Documentos");
  const wanted = useSearchParam("projeto");
  const q = useAsync(() => api.documentProjects(), []);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = q.data ?? [];
  const current = list.find((x) => x.id === (chosen ?? wanted)) ?? list[0];

  return (
    <div className="page">
      <PageHead title="Documentos" subtitle="Envie aqui os documentos que o seu projeto precisa. A equipe confere cada um e avisa se precisar de um novo envio." />
      {q.error ? <LoadError message={q.error} onRetry={() => void q.reload()} />
        : !q.data ? <Skeleton height={420} radius={16} />
        : list.length === 0 ? <Card><EmptyState icon="file" title="Nenhum documento pedido por enquanto." text="Quando a equipe precisar de algum documento, ele aparece aqui e você recebe um aviso." /></Card>
        : (
          <>
            {list.length > 1 && (
              <div className="chips dlvprojects" role="group" aria-label="Projeto">
                {list.map((x) => {
                  const open = x.progress.pending + x.progress.rejected;
                  return (
                    <button key={x.id} type="button" className={cx("chip")} aria-pressed={x.id === current.id} onClick={() => setChosen(x.id)}>
                      {x.name}{open > 0 && <span className="chip__n">{open}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <DocumentsView key={current.id} projectId={current.id} />
          </>
        )}
    </div>
  );
}
