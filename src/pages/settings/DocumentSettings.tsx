import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Badge, Button, Card, EmptyState, Input, LoadError, Skeleton } from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { useDragSort } from "@/components/ui/sortable";
import { cx } from "@/utils/format";
import type { DocumentType, DocumentTypesList } from "@/types/domain";

/* Configurações › Documentos do cliente: lista padrão da rede (ADM Global edita). */
export function DocumentSettingsPanel() {
  const toast = useToast();
  const q = useAsync(() => api.documentTypes(), []);
  const [order, setOrder] = useState<DocumentType[]>([]);
  const [editing, setEditing] = useState<DocumentType | "new" | null>(null);
  const [removing, setRemoving] = useState<DocumentType | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setOrder(q.data.types); }, [q.data]);
  const editable = !!q.data?.can_edit;
  const sort = useDragSort(order, async (next) => {
    const prev = order;
    setOrder(next);
    try { await api.documentTypesReorder(next.map((t) => t.id)); }
    catch (e) { setOrder(prev); toast((e as Error).message, "error"); }
  });

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <Skeleton height={360} radius={16} />;
  const services = q.data.services;
  const svcName = (code: string) => services.find((s) => s.code === code)?.name ?? code.replaceAll("_", " ");

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try { await api.documentTypeDelete(removing.id); toast("Documento excluído da lista padrão."); setRemoving(null); await q.reload(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <div className="settings__grid">
      <div className="stack">
        <Card title="Documentos pedidos ao cliente" count={order.length || undefined} flush
          action={editable && <Button icon="plus" size="sm" onClick={() => setEditing("new")}>Novo documento</Button>}>
          {order.length === 0 ? (
            <div className="settings__pad"><EmptyState icon="file" title="Nenhum documento na lista padrão."
              text={editable ? "Inclua os documentos que o cliente precisa enviar. Eles aparecem nos projetos na ordem desta lista." : undefined} /></div>
          ) : (
            <ol className="tasklist doctypes">
              {order.map((t, i) => (
                <li key={t.id} {...(editable ? sort.row(i) : {})}
                  className={cx(editable && sort.dragging === i && "is-dragging", editable && sort.over === i && sort.dragging !== i && "is-over")}>
                  <div className="task">
                    {editable && <span className="drag-grip" {...sort.grip(i, `Mover ${t.name}`)}><Icon name="grip" size={16} /></span>}
                    <span className="doctypes__n num" aria-hidden="true">{i + 1}</span>
                    <span className="task__main">
                      <span className="task__name">{t.name}</span>
                      <span className="doctypes__tags">
                        {t.required ? <Badge tone="warning" outline>Obrigatório para iniciar</Badge> : <Badge outline>Opcional</Badge>}
                        <span className="muted">{t.service_codes?.length ? `Só com: ${t.service_codes.map(svcName).join(", ")}` : "Todos os projetos"}</span>
                      </span>
                      {t.description && <span className="task__meta">{t.description}</span>}
                    </span>
                    {editable && (
                      <span className="task__side">
                        <Button variant="ghost" size="sm" iconOnly icon="edit" onClick={() => setEditing(t)}>Editar {t.name}</Button>
                        <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => setRemoving(t)}>Excluir {t.name}</Button>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>Cada projeto recebe os documentos desta lista, <b>na mesma ordem</b>, e o cliente envia pelo portal (arquivo ou link). A equipe confere: aprova ou pede um novo envio.</p>
        <p><b>Obrigatório para iniciar:</b> quando o projeto começa, abre-se o prazo de envio do cliente (definido por unidade em Customer Success). Vencido, o cronograma é adiado como nos demais retornos do cliente.</p>
        <p>Um documento pode valer para <b>todos os projetos</b> ou só para quem contrata certos serviços. A liderança de cada projeto ainda pode pedir documentos extras ou remover os que não fazem sentido.</p>
        <p>Excluir daqui tira o pedido dos projetos onde ainda não houve envio.{editable ? " Arraste pela alça para ordenar." : " Somente o ADM Global altera esta lista."}</p>
      </aside>
      {editing && <TypeDrawer item={editing === "new" ? null : editing} list={q.data} onClose={() => setEditing(null)}
        onSaved={(msg) => { toast(msg); setEditing(null); void q.reload(); }} />}
      <ConfirmDialog open={!!removing} danger title={`Excluir “${removing?.name ?? ""}” da lista?`} loading={busy}
        message="Sai dos projetos onde o cliente ainda não enviou. Onde já houve envio, o documento continua com os arquivos."
        confirmLabel="Excluir" onCancel={() => setRemoving(null)} onConfirm={remove} />
    </div>
  );
}

function TypeDrawer({ item, list, onClose, onSaved }: { item: DocumentType | null; list: DocumentTypesList; onClose: () => void; onSaved: (msg: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(item?.name ?? "");
  const [desc, setDesc] = useState(item?.description ?? "");
  const [required, setRequired] = useState(item?.required ?? false);
  const [scope, setScope] = useState<"all" | "some">(item?.service_codes?.length ? "some" : "all");
  const [codes, setCodes] = useState<string[]>(item?.service_codes ?? []);
  const [busy, setBusy] = useState(false);
  const families = [...new Set(list.services.map((s) => s.family))];
  const invalid = name.trim().length < 2 || (scope === "some" && codes.length === 0);

  async function save() {
    setBusy(true);
    try {
      await api.documentTypeSave(item?.id ?? null, name, desc, required, scope === "some" ? codes : []);
      onSaved(item ? "Documento atualizado. Os projetos já mostram a mudança." : "Documento incluído na lista padrão.");
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <Drawer open onClose={onClose} title={item ? "Editar documento" : "Novo documento"} subtitle="Lista padrão de documentos do cliente"
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy} disabled={invalid} onClick={save}>{item ? "Salvar" : "Incluir"}</Button></>}>
      <div className="form">
        <label className="field">
          <span className="field__label">Documento</span>
          <Input value={name} maxLength={120} autoFocus placeholder="Ex.: Matrícula atualizada do imóvel" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Orientação ao cliente <small>(opcional)</small></span>
          <textarea className="input textarea" rows={3} maxLength={1000} value={desc} placeholder="Onde conseguir, validade, formato aceito…" onChange={(e) => setDesc(e.target.value)} />
        </label>
        <label className="pset__check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <span><b>Obrigatório para iniciar o desenvolvimento</b><small>Entra no prazo de envio do cliente; vencido, o cronograma do projeto é adiado.</small></span>
        </label>
        <fieldset className="field docscope">
          <legend className="field__label">Pedir em quais projetos?</legend>
          <label className="pset__check"><input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} /><span><b>Todos os projetos</b></span></label>
          <label className="pset__check"><input type="radio" name="scope" checked={scope === "some"} onChange={() => setScope("some")} /><span><b>Só quando o projeto contratar…</b></span></label>
          {scope === "some" && (
            <div className="docscope__list">
              {families.map((f) => (
                <div key={f}>
                  <span className="docscope__fam">{f}</span>
                  {list.services.filter((s) => s.family === f).map((s) => (
                    <label key={s.code} className="docscope__opt">
                      <input type="checkbox" checked={codes.includes(s.code)}
                        onChange={(e) => setCodes(e.target.checked ? [...codes, s.code] : codes.filter((c) => c !== s.code))} />
                      {s.name}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </Drawer>
  );
}
