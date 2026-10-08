import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Link } from "@/lib/router";
import { Badge, Button, Card, EmptyState, Field, Input, LoadError, SearchInput, Select, Skeleton } from "@/components/ui/primitives";
import { ConfirmDialog, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, plural } from "@/utils/format";
import type { FaqCategory, FaqItem } from "@/types/domain";
import { FaqAnswer } from "@/pages/faq/FaqAnswer";
import { normalize } from "@/pages/faq/faqSearch";

/* ==========================================================================
   Configurações › FAQ (administração global): perguntas, respostas,
   palavras-chave, categorias e o retorno dos leitores
   ========================================================================== */
type Draft = { id: string | null; category_id: string; question: string; answer: string; keywords: string };

export function FaqSettings() {
  const toast = useToast();
  const q = useAsync(() => api.listFaq(), []);
  const fb = useAsync(() => api.listFaqFeedback(300), []);
  const categories = q.data?.categories ?? [];
  const items = q.data?.items ?? [];
  const [cat, setCat] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<FaqItem | null>(null);
  const [catName, setCatName] = useState("");
  const [editingCat, setEditingCat] = useState<{ id: string; title: string } | null>(null);
  const [removingCat, setRemovingCat] = useState<FaqCategory | null>(null);

  useEffect(() => { if (!cat && categories.length) setCat(categories[0].id); }, [cat, categories]);
  const count = useMemo(() => {
    const m = new Map<string, number>();
    items.forEach((it) => m.set(it.category_id, (m.get(it.category_id) ?? 0) + 1));
    return m;
  }, [items]);
  const catTitle = useMemo(() => new Map(categories.map((c) => [c.id, c.title])), [categories]);
  const f = normalize(filter.trim());
  const list = f
    ? items.filter((it) => normalize(`${it.question} ${it.keywords ?? ""} ${it.answer}`).includes(f))
    : items.filter((it) => it.category_id === cat);
  const current = categories.find((c) => c.id === cat);

  async function saveItem(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      await api.faqItemSave({ id: draft.id, category_id: draft.category_id, question: draft.question.trim(), answer: draft.answer.trim(), keywords: draft.keywords.trim() || null });
      toast(draft.id ? "Pergunta atualizada." : "Pergunta incluída.");
      setCat(draft.category_id); setDraft(null); await q.reload();
    } catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function archiveItem(it: FaqItem) {
    setBusy(true);
    try { await api.faqItemArchive(it.id); toast("Pergunta excluída."); setRemoving(null); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function addCategory(e: FormEvent) {
    e.preventDefault();
    if (catName.trim().length < 2) return;
    setBusy(true);
    try { const id = await api.faqCategorySave(null, catName.trim()); setCatName(""); toast("Categoria incluída."); await q.reload(); setCat(id); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function renameCategory() {
    if (!editingCat || editingCat.title.trim().length < 2) return;
    setBusy(true);
    try { await api.faqCategorySave(editingCat.id, editingCat.title.trim()); setEditingCat(null); toast("Categoria renomeada."); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }
  async function archiveCategory(c: FaqCategory) {
    setBusy(true);
    try { await api.faqCategoryArchive(c.id); toast("Categoria excluída."); setRemovingCat(null); if (cat === c.id) setCat(null); await q.reload(); }
    catch (err) { toast((err as Error).message, "error"); } finally { setBusy(false); }
  }

  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (q.loading && !q.data) return <Skeleton height={320} radius={16} />;

  return (
    <div className="faqadm">
      <Card title="Categorias" count={categories.length || undefined} flush className="faqadm__cats">
        <ul className="sectors">
          {categories.map((c) => (
            <li key={c.id} className={cx("sector faqadm__cat", cat === c.id && !f && "is-active")}>
              {editingCat?.id === c.id ? (
                <form className="sector__edit" onSubmit={(e) => { e.preventDefault(); void renameCategory(); }}>
                  <Input aria-label="Nome da categoria" autoFocus value={editingCat.title} maxLength={80}
                    onChange={(e) => setEditingCat({ ...editingCat, title: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setEditingCat(null)} />
                  <Button size="sm" type="submit" iconOnly icon="check" loading={busy}>Salvar</Button>
                </form>
              ) : (
                <>
                  <button type="button" className="faqadm__catbtn" onClick={() => { setCat(c.id); setFilter(""); }} aria-pressed={cat === c.id}>
                    <span className="sector__name">{c.title}</span>
                    <span className="sector__people">{count.get(c.id) ?? 0}</span>
                  </button>
                  <span className="sector__actions">
                    <Button size="sm" variant="ghost" iconOnly icon="edit" onClick={() => setEditingCat({ id: c.id, title: c.title })}>Renomear {c.title}</Button>
                    <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setRemovingCat(c)}>Excluir {c.title}</Button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        <form className="sector__add" onSubmit={addCategory}>
          <Input aria-label="Nova categoria" placeholder="Nova categoria" value={catName} maxLength={80} onChange={(e) => setCatName(e.target.value)} />
          <Button type="submit" iconOnly icon="plus" disabled={catName.trim().length < 2}>Incluir categoria</Button>
        </form>
      </Card>

      <div className="stack">
        <Card flush title={f ? "Resultado da busca" : current?.title ?? "Perguntas"} count={list.length || undefined}
          action={<Button size="sm" icon="plus" disabled={!categories.length}
            onClick={() => setDraft({ id: null, category_id: cat ?? categories[0]?.id ?? "", question: "", answer: "", keywords: "" })}>Nova pergunta</Button>}>
          <div className="faqadm__bar">
            <SearchInput aria-label="Buscar pergunta" placeholder="Buscar em todas as perguntas" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <Link to="/duvidas" className="link">Ver como o cliente vê</Link>
          </div>
          {list.length === 0 ? (
            <EmptyState compact icon="help" title={f ? "Nenhuma pergunta encontrada." : "Nenhuma pergunta nesta categoria."}
              text={f ? "Tente outra palavra." : "Inclua a primeira pergunta pelo botão acima."} />
          ) : (
            <ul className="faqadm__list">
              {list.map((it) => (
                <li key={it.id} className="faqadm__item">
                  <div className="grow">
                    <p className="faqadm__q">{it.question}</p>
                    {(f || it.keywords) && (
                      <p className="faqadm__meta">
                        {f && <Badge tag>{catTitle.get(it.category_id)}</Badge>}
                        {it.keywords && <span>Palavras-chave: {it.keywords}</span>}
                      </p>
                    )}
                  </div>
                  <span className="sector__actions">
                    <Button size="sm" variant="ghost" iconOnly icon="edit"
                      onClick={() => setDraft({ id: it.id, category_id: it.category_id, question: it.question, answer: it.answer, keywords: it.keywords ?? "" })}>Editar pergunta</Button>
                    <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setRemoving(it)}>Excluir pergunta</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <FeedbackCard loading={fb.loading && !fb.data} error={fb.error} rows={fb.data ?? []} items={items} onRetry={() => void fb.reload()} />
      </div>

      <Modal open={!!draft} onClose={() => setDraft(null)} wide title={draft?.id ? "Editar pergunta" : "Nova pergunta"}
        footer={<>
          <Button variant="ghost" onClick={() => setDraft(null)}>Cancelar</Button>
          <Button type="submit" form="faq-form" icon="check" loading={busy}
            disabled={!draft || draft.question.trim().length < 5 || draft.answer.trim().length < 2 || !draft.category_id}>Salvar</Button>
        </>}>
        {draft && (
          <form id="faq-form" className="faqadm__form" onSubmit={saveItem}>
            <div className="faqadm__fields">
              <Field label="Categoria" required>
                {({ id }) => (
                  <Select id={id} value={draft.category_id} onChange={(e) => setDraft({ ...draft, category_id: e.target.value })}>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Pergunta" required>
                {({ id }) => <Input id={id} value={draft.question} maxLength={300} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />}
              </Field>
              <Field label="Resposta" required hint={<>Linha em branco separa parágrafos. Comece a linha com <b>- </b> para lista e <b>1. </b> para lista numerada. Use <b>*texto*</b> para destacar.</>}>
                {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="input textarea faqadm__answer" rows={12} maxLength={8000}
                  value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />}
              </Field>
              <Field label="Palavras-chave" hint="Outras palavras que o cliente pode usar para esta dúvida, separadas por vírgula. Ajudam a busca a encontrar esta pergunta.">
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={draft.keywords} maxLength={500}
                  placeholder="Ex.: comunique-se, pendência, notificação" onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />}
              </Field>
            </div>
            <div className="faqadm__preview">
              <span className="label">Prévia</span>
              <h3>{draft.question || "Pergunta"}</h3>
              {draft.answer.trim() ? <FaqAnswer text={draft.answer} /> : <p className="faqadm__muted">A resposta aparece aqui como o cliente vai ver.</p>}
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog open={!!removing} danger title="Excluir esta pergunta?"
        message={removing ? `“${removing.question}” deixa de aparecer para clientes e equipe.` : ""}
        confirmLabel="Excluir pergunta" loading={busy} onCancel={() => setRemoving(null)} onConfirm={() => removing && archiveItem(removing)} />
      <ConfirmDialog open={!!removingCat} danger title={`Excluir a categoria “${removingCat?.title ?? ""}”?`}
        message={removingCat && (count.get(removingCat.id) ?? 0) > 0
          ? `Ela ainda tem ${plural(count.get(removingCat.id) ?? 0, "pergunta", "perguntas")}. Mova ou exclua as perguntas antes.`
          : "A categoria está vazia e deixa de aparecer."}
        confirmDisabled={!!removingCat && (count.get(removingCat.id) ?? 0) > 0}
        confirmLabel="Excluir categoria" loading={busy} onCancel={() => setRemovingCat(null)} onConfirm={() => removingCat && archiveCategory(removingCat)} />
    </div>
  );
}

/* ---------- O que os leitores disseram ---------- */
function FeedbackCard({ loading, error, rows, items, onRetry }: {
  loading: boolean; error: string | null; rows: { id: string; item_id: string | null; helpful: boolean; query: string | null; created_at: string }[];
  items: FaqItem[]; onRetry: () => void;
}) {
  const question = useMemo(() => new Map(items.map((i) => [i.id, i.question])), [items]);
  const yes = rows.filter((r) => r.helpful).length;
  const no = rows.filter((r) => !r.helpful);
  const notFound = no.filter((r) => !r.item_id).length;
  return (
    <Card title="Retorno dos leitores" flush>
      {error ? <div className="settings__pad"><LoadError message={error} onRetry={onRetry} /></div>
        : loading ? <div className="settings__pad"><Skeleton height={80} radius={12} /></div> : (
        <>
          <div className="faqfb__stats">
            <span>Ajudou <b>{yes}</b></span>
            <span>Não ajudou <b>{no.length - notFound}</b></span>
            <span>Sem resposta no FAQ <b>{notFound}</b></span>
          </div>
          {no.length === 0 ? (
            <EmptyState compact icon="checkCircle" title="Nenhum retorno negativo até agora."
              text="Quando alguém marcar “Não” ou disser que não encontrou a dúvida, aparece aqui com o que a pessoa escreveu." />
          ) : (
            <ul className="faqfb__list">
              {no.slice(0, 40).map((r) => (
                <li key={r.id} className="faqfb__row">
                  <Icon name={r.item_id ? "x" : "search"} size={14} />
                  <div className="grow">
                    <p className="faqfb__query">{r.query ? `“${r.query}”` : <span className="faqadm__muted">Sem texto digitado</span>}</p>
                    <p className="faqadm__meta">{r.item_id ? `Não respondeu: ${question.get(r.item_id) ?? "pergunta excluída"}` : "Não encontrou a dúvida no FAQ"}</p>
                  </div>
                  <time className="faqfb__date" dateTime={r.created_at}>{new Date(r.created_at).toLocaleDateString("pt-BR")}</time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
