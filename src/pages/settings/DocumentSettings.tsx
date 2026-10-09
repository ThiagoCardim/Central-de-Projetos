import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Badge, Button, Card, EmptyState, Input, LoadError, Segmented, Select, Skeleton } from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { useDragSort } from "@/components/ui/sortable";
import { cx } from "@/utils/format";
import type { DocQuestion, DocSection, DocumentType, DocumentTypesList } from "@/types/domain";

/* Configurações › Documentos do cliente: lista padrão da rede (ADM Global edita). */
const HOLDER_LABEL = { pf: "Só pessoa física", pj: "Só pessoa jurídica" } as const;
const NO_SECTION = "__none";

export function DocumentSettingsPanel() {
  const toast = useToast();
  const q = useAsync(() => api.documentTypes(), []);
  const [types, setTypes] = useState<DocumentType[]>([]);
  const [editing, setEditing] = useState<{ item: DocumentType | null; section: string | null } | null>(null);
  const [removing, setRemoving] = useState<DocumentType | null>(null);
  const [sectionEdit, setSectionEdit] = useState<DocSection | "new" | null>(null);
  const [questionEdit, setQuestionEdit] = useState<DocQuestion | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setTypes(q.data.types); }, [q.data]);

  const data = q.data;
  const editable = !!data?.can_edit;
  const sections = data?.sections ?? [];
  const groups = useMemo(() => {
    const g = sections.map((s) => ({ key: s.id, section: s as DocSection | null, items: types.filter((t) => t.section_id === s.id) }));
    const loose = types.filter((t) => !t.section_id || !sections.some((s) => s.id === t.section_id));
    if (loose.length || sections.length === 0) g.push({ key: NO_SECTION, section: null, items: loose });
    return g;
  }, [sections, types]);

  async function saveOrder(next: DocumentType[]) {
    const prev = types;
    setTypes(next);
    try { await api.documentTypesReorder(next.map((t) => t.id)); } catch (e) { setTypes(prev); toast((e as Error).message, "error"); }
  }
  async function moveSection(i: number, d: -1 | 1) {
    const ids = sections.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await api.documentSectionsReorder(ids); await q.reload(); } catch (e) { toast((e as Error).message, "error"); }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true);
    try { await api.documentTypeDelete(removing.id); toast("Documento excluído da lista padrão."); setRemoving(null); await q.reload(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!data) return <Skeleton height={360} radius={16} />;
  const qText = (id: string | null) => data.questions.find((x) => x.id === id)?.text;
  const svcName = (code: string) => data.services.find((s) => s.code === code)?.name ?? code.replaceAll("_", " ");

  return (
    <div className="settings__grid">
      <div className="stack">
        {editable && (
          <div className="row-between">
            <span className="subtext">{types.length} documentos em {sections.length} seções. Arraste pela alça para ordenar dentro da seção.</span>
            <div className="row">
              <Button variant="secondary" size="sm" icon="plus" onClick={() => setSectionEdit("new")}>Nova seção</Button>
              <Button size="sm" icon="plus" onClick={() => setEditing({ item: null, section: sections[0]?.id ?? null })}>Novo documento</Button>
            </div>
          </div>
        )}
        {types.length === 0 && sections.length === 0 && (
          <Card><EmptyState icon="file" title="Nenhum documento na lista padrão."
            text={editable ? "Crie as seções (ex.: Documentação do proprietário) e inclua os documentos que o cliente precisa enviar." : undefined} /></Card>
        )}
        {groups.map((g, gi) => (
          <SectionCard key={g.key} n={g.section ? gi + 1 : null} section={g.section} items={g.items} editable={editable}
            first={gi === 0} last={!g.section || gi === sections.length - 1}
            onMove={(d) => moveSection(gi, d)} onRename={() => g.section && setSectionEdit(g.section)}
            onAdd={() => setEditing({ item: null, section: g.section?.id ?? null })}
            onReorder={(nextItems) => saveOrder(groups.flatMap((x) => (x.key === g.key ? nextItems : x.items)))}
            onEdit={(t) => setEditing({ item: t, section: t.section_id })} onRemove={setRemoving}
            describe={(t) => [t.holder ? HOLDER_LABEL[t.holder] : null,
              t.question_id ? `Se “${qText(t.question_id) ?? "pergunta"}” = Sim` : null,
              t.service_codes?.length ? `Só com: ${t.service_codes.map(svcName).join(", ")}` : null].filter(Boolean).join(" · ") || "Todos os projetos"} />
        ))}

        <Card title="Perguntas ao cliente" count={data.questions.length || undefined}
          action={editable && <Button size="sm" variant="secondary" icon="plus" onClick={() => setQuestionEdit("new")}>Nova pergunta</Button>}>
          <p className="subtext">Um documento pode depender de uma resposta “Sim” do cliente. A pergunta aparece no portal do cliente; a equipe também pode responder.</p>
          {data.questions.length > 0 && (
            <ul className="docq-list">
              {data.questions.map((x) => (
                <li key={x.id}>
                  <Icon name="help" size={16} />
                  <span className="grow"><b>{x.text}</b>{x.help && <span className="subtext"> · {x.help}</span>}
                    <span className="subtext"> · {types.filter((t) => t.question_id === x.id).length} documentos dependem</span></span>
                  {editable && <Button variant="ghost" size="sm" iconOnly icon="edit" onClick={() => setQuestionEdit(x)}>Editar pergunta</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>Cada projeto recebe os documentos desta lista, <b>na mesma ordem e com as mesmas seções</b>, e o cliente envia pelo portal (arquivo ou link). A equipe confere: aprova ou pede um novo envio.</p>
        <p><b>Obrigatório para iniciar:</b> quando o projeto começa, abre-se o prazo de envio do cliente (definido por unidade em Customer Success). Vencido, o cronograma é adiado como nos demais retornos do cliente.</p>
        <p><b>Pessoa física ou jurídica:</b> vem do CPF/CNPJ do cliente (sem documento: B2C é física, B2B é jurídica).</p>
        <p>A liderança de cada projeto ainda pode pedir documentos extras ou remover os que não fazem sentido.</p>
        <p>Excluir daqui tira o pedido dos projetos onde ainda não houve envio.{editable ? "" : " Somente o ADM Global altera esta lista."}</p>
      </aside>
      {editing && <TypeDrawer item={editing.item} defaultSection={editing.section} list={data} onClose={() => setEditing(null)}
        onSaved={(msg) => { toast(msg); setEditing(null); void q.reload(); }} />}
      {sectionEdit && <SectionModal item={sectionEdit === "new" ? null : sectionEdit} empty={sectionEdit !== "new" && !types.some((t) => t.section_id === sectionEdit.id)}
        onClose={() => setSectionEdit(null)} onSaved={(msg) => { toast(msg); setSectionEdit(null); void q.reload(); }} />}
      {questionEdit && <QuestionModal item={questionEdit === "new" ? null : questionEdit} inUse={questionEdit !== "new" && types.some((t) => t.question_id === questionEdit.id)}
        onClose={() => setQuestionEdit(null)} onSaved={(msg) => { toast(msg); setQuestionEdit(null); void q.reload(); }} />}
      <ConfirmDialog open={!!removing} danger title={`Excluir “${removing?.name ?? ""}” da lista?`} loading={busy}
        message="Sai dos projetos onde o cliente ainda não enviou. Onde já houve envio, o documento continua com os arquivos."
        confirmLabel="Excluir" onCancel={() => setRemoving(null)} onConfirm={remove} />
    </div>
  );
}

function SectionCard({ n, section, items, editable, first, last, onMove, onRename, onAdd, onReorder, onEdit, onRemove, describe }: {
  n: number | null; section: DocSection | null; items: DocumentType[]; editable: boolean; first: boolean; last: boolean;
  onMove: (d: -1 | 1) => void; onRename: () => void; onAdd: () => void; onReorder: (next: DocumentType[]) => void;
  onEdit: (t: DocumentType) => void; onRemove: (t: DocumentType) => void; describe: (t: DocumentType) => string;
}) {
  const sort = useDragSort(items, onReorder);
  return (
    <Card flush className="docsec"
      title={<>{n != null && <span className="docsec__n num">{n}.</span>} {section?.name ?? "Sem seção"}</>}
      count={items.length || undefined}
      action={editable && (
        <div className="row docsec__tools">
          {section && <Button variant="ghost" size="sm" iconOnly icon="chevronDown" className="flip" disabled={first} onClick={() => onMove(-1)}>Mover seção para cima</Button>}
          {section && <Button variant="ghost" size="sm" iconOnly icon="chevronDown" disabled={last} onClick={() => onMove(1)}>Mover seção para baixo</Button>}
          {section && <Button variant="ghost" size="sm" iconOnly icon="edit" onClick={onRename}>Editar seção</Button>}
          <Button variant="ghost" size="sm" icon="plus" onClick={onAdd}>Documento</Button>
        </div>
      )}>
      {items.length === 0 ? <p className="subtext settings__pad">Nenhum documento nesta seção.</p> : (
        <ol className="tasklist doctypes">
          {items.map((t, i) => (
            <li key={t.id} {...(editable ? sort.row(i) : {})}
              className={cx(editable && sort.dragging === i && "is-dragging", editable && sort.over === i && sort.dragging !== i && "is-over")}>
              <div className="task">
                {editable && <span className="drag-grip" {...sort.grip(i, `Mover ${t.name}`)}><Icon name="grip" size={16} /></span>}
                <span className="task__main">
                  <span className="task__name">{t.name}</span>
                  <span className="doctypes__tags">
                    {t.required ? <Badge tone="warning" outline>Obrigatório para iniciar</Badge> : <Badge outline>Opcional</Badge>}
                    <span className="muted">{describe(t)}</span>
                  </span>
                  {t.description && <span className="task__meta">{t.description}</span>}
                </span>
                {editable && (
                  <span className="task__side">
                    <Button variant="ghost" size="sm" iconOnly icon="edit" onClick={() => onEdit(t)}>Editar {t.name}</Button>
                    <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => onRemove(t)}>Excluir {t.name}</Button>
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function TypeDrawer({ item, defaultSection, list, onClose, onSaved }: {
  item: DocumentType | null; defaultSection: string | null; list: DocumentTypesList; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(item?.name ?? "");
  const [desc, setDesc] = useState(item?.description ?? "");
  const [required, setRequired] = useState(item?.required ?? true);
  const [section, setSection] = useState(item ? item.section_id ?? "" : defaultSection ?? "");
  const [holder, setHolder] = useState<"all" | "pf" | "pj">(item?.holder ?? "all");
  const [question, setQuestion] = useState(item?.question_id ?? "");
  const [scope, setScope] = useState<"all" | "some">(item?.service_codes?.length ? "some" : "all");
  const [codes, setCodes] = useState<string[]>(item?.service_codes ?? []);
  const [busy, setBusy] = useState(false);
  const families = [...new Set(list.services.map((s) => s.family))];
  const invalid = name.trim().length < 2 || (scope === "some" && codes.length === 0);

  async function save() {
    setBusy(true);
    try {
      await api.documentTypeSave(item?.id ?? null, { name, description: desc, required, serviceCodes: scope === "some" ? codes : [],
        sectionId: section || null, holder: holder === "all" ? null : holder, questionId: question || null });
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
        <label className="field">
          <span className="field__label">Seção</span>
          <Select value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="">Sem seção</option>
            {list.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </label>
        <label className="pset__check">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <span><b>Obrigatório para iniciar o desenvolvimento</b><small>Entra no prazo de envio do cliente; vencido, o cronograma do projeto é adiado.</small></span>
        </label>
        <div className="field">
          <span className="field__label">Proprietário</span>
          <Segmented<"all" | "pf" | "pj"> label="Proprietário" value={holder} onChange={setHolder}
            options={[{ value: "all", label: "Todos" }, { value: "pf", label: "Pessoa física" }, { value: "pj", label: "Pessoa jurídica" }]} />
          <span className="field__hint">Definido pelo CPF/CNPJ do cliente no projeto.</span>
        </div>
        <label className="field">
          <span className="field__label">Pedir somente se o cliente responder “Sim” a</span>
          <Select value={question} onChange={(e) => setQuestion(e.target.value)}>
            <option value="">Sempre pedir (sem pergunta)</option>
            {list.questions.map((x) => <option key={x.id} value={x.id}>{x.text}</option>)}
          </Select>
          <span className="field__hint">As perguntas ficam no fim desta página.</span>
        </label>
        <fieldset className="field docscope">
          <legend className="field__label">Serviços</legend>
          <label className="pset__check"><input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} /><span><b>Qualquer serviço contratado</b></span></label>
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

function SectionModal({ item, empty, onClose, onSaved }: { item: DocSection | null; empty: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState(item?.name ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  async function save() {
    setBusy("save");
    try { await api.documentSectionSave(item?.id ?? null, name); onSaved(item ? "Seção renomeada." : "Seção criada."); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function del() {
    setBusy("delete");
    try { await api.documentSectionDelete(item!.id); onSaved("Seção excluída."); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  return (
    <Modal open onClose={onClose} title={item ? "Editar seção" : "Nova seção"}
      footer={<>
        {item && <Button variant="danger-ghost" loading={busy === "delete"} disabled={!empty} title={empty ? undefined : "Mova ou exclua os documentos antes"} onClick={del}>Excluir seção</Button>}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy === "save"} disabled={name.trim().length < 2} onClick={save}>Salvar</Button>
      </>}>
      <label className="field">
        <span className="field__label">Nome da seção</span>
        <Input value={name} maxLength={120} autoFocus placeholder="Ex.: Documentação do proprietário" onChange={(e) => setName(e.target.value)} />
      </label>
    </Modal>
  );
}

function QuestionModal({ item, inUse, onClose, onSaved }: { item: DocQuestion | null; inUse: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const toast = useToast();
  const [text, setText] = useState(item?.text ?? "");
  const [help, setHelp] = useState(item?.help ?? "");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  async function save() {
    setBusy("save");
    try { await api.documentQuestionSave(item?.id ?? null, text, help); onSaved(item ? "Pergunta atualizada." : "Pergunta criada."); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function del() {
    setBusy("delete");
    try { await api.documentQuestionDelete(item!.id); onSaved("Pergunta excluída."); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  return (
    <Modal open onClose={onClose} title={item ? "Editar pergunta" : "Nova pergunta ao cliente"}
      footer={<>
        {item && <Button variant="danger-ghost" loading={busy === "delete"} disabled={inUse} title={inUse ? "Há documentos que dependem dela" : undefined} onClick={del}>Excluir</Button>}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="check" loading={busy === "save"} disabled={text.trim().length < 5} onClick={save}>Salvar</Button>
      </>}>
      <div className="stack">
        <label className="field">
          <span className="field__label">Pergunta (resposta Sim ou Não)</span>
          <Input value={text} maxLength={200} autoFocus placeholder="Ex.: O imóvel fica em condomínio?" onChange={(e) => setText(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Explicação <small>(opcional)</small></span>
          <Input value={help} maxLength={500} placeholder="Ajuda o cliente a responder" onChange={(e) => setHelp(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
