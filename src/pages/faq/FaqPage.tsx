import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useSearchParam } from "@/lib/router";
import { useAuth } from "@/services/auth";
import { PageHead } from "@/layouts/AppLayout";
import { Badge, Button, Card, EmptyState, LoadError, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, plural } from "@/utils/format";
import type { FaqCategory, FaqItem } from "@/types/domain";
import { buildIndex, isConfident, words, type FaqHit } from "./faqSearch";
import { FaqAnswer, FaqFeedback, Highlight } from "./FaqAnswer";

/* ==========================================================================
   Dúvidas frequentes: o cliente escreve a dúvida e vê a resposta mais próxima
   ========================================================================== */
const EXAMPLES = ["Quanto tempo demora a aprovação?", "Quem paga as taxas?", "Posso alterar o projeto depois de aprovado?", "O que é ART?"];

export function FaqPage() {
  useDocumentTitle("Dúvidas frequentes");
  const isClient = useAuth().permissions?.role === "client";
  const initial = useSearchParam("q") ?? "";
  const q = useAsync(() => api.listFaq(), []);
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial.trim());
  const inputRef = useRef<HTMLInputElement>(null);

  // busca enquanto digita (pequena pausa para não piscar)
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 160);
    return () => clearTimeout(t);
  }, [text]);

  const categories = q.data?.categories ?? [];
  const items = q.data?.items ?? [];
  const index = useMemo(() => buildIndex(items, categories), [items, categories]);
  const catTitle = useMemo(() => new Map(categories.map((c) => [c.id, c.title])), [categories]);
  const searching = words(query).length > 0;

  function ask(s: string) { setText(s); setQuery(s); inputRef.current?.focus(); }

  return (
    <div className="page faq">
      <PageHead title="Dúvidas frequentes"
        subtitle="Respostas da equipe YouCon sobre documentação, aprovação, prazos e o andamento do projeto."
        actions={isClient ? <Link to="/ajuda" className="btn btn--secondary"><Icon name="chat" /> Preciso de ajuda</Link> : undefined} />

      <section className="faq-hero" aria-label="Buscar dúvida">
        <label htmlFor="faq-q" className="faq-hero__label">Qual é a sua dúvida?</label>
        <div className="faq-search">
          <Icon name="search" />
          <input id="faq-q" ref={inputRef} className="input input--lg" type="search" autoComplete="off" autoFocus={!initial}
            placeholder="Escreva com suas palavras. Ex.: quanto tempo leva para a prefeitura aprovar?"
            value={text} maxLength={300} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setText(""); }} />
          {text && <Button size="sm" variant="ghost" iconOnly icon="x" className="faq-search__clear" onClick={() => ask("")}>Limpar busca</Button>}
        </div>
        {!searching && (
          <div className="faq-hero__examples">
            <span>Exemplos:</span>
            {EXAMPLES.map((ex) => <button key={ex} type="button" className="faq-chip" onClick={() => ask(ex)}>{ex}</button>)}
          </div>
        )}
      </section>

      {q.error ? <LoadError message={q.error} onRetry={() => void q.reload()} />
        : q.loading && !q.data ? <div className="stack"><Skeleton height={56} radius={12} /><Skeleton height={240} radius={16} /></div>
        : items.length === 0 ? <Card><EmptyState icon="search" title="Nenhuma pergunta publicada ainda." text="Em breve a equipe YouCon publicará as respostas mais comuns aqui." /></Card>
        : searching ? <Results key={query} isClient={isClient} query={query} hits={index.search(query, 8)} stems={index.queryStems(query)} catTitle={catTitle} onBrowse={() => ask("")} />
        : <Browse categories={categories} items={items} />}
    </div>
  );
}

/* ---------- Resultado da busca ---------- */
function Results({ isClient, query, hits, stems, catTitle, onBrowse }: {
  isClient: boolean; query: string; hits: FaqHit[]; stems: Set<string>; catTitle: Map<string, string>; onBrowse: () => void;
}) {
  const confident = isConfident(hits);
  const [best, ...rest] = hits;
  const others = confident ? rest.slice(0, 6) : hits.slice(0, 6);

  if (hits.length === 0) {
    return (
      <Card>
        <EmptyState icon="search" title="Não encontramos uma resposta para isso."
          text="Tente escrever de outro jeito, com menos palavras, ou navegue pelas categorias."
          action={<div className="faq-actions">{isClient && <HelpLink />}<NotFound query={query} /><Button size="sm" variant="ghost" onClick={onBrowse}>Ver todas as categorias</Button></div>} />
      </Card>
    );
  }

  return (
    <div className="faq-results">
      {confident ? (
        <Card as="article" className="faq-best" aria-label="Resposta mais provável">
          <div className="faq-best__head">
            <span className="label faq-best__label"><Icon name="checkCircle" size={14} /> Resposta mais provável</span>
            <Badge tag>{catTitle.get(best.item.category_id) ?? "Geral"}</Badge>
          </div>
          <h2 className="faq-best__q"><Highlight text={best.item.question} stems={stems} /></h2>
          <FaqAnswer text={best.item.answer} />
          <FaqFeedback key={best.item.id} itemId={best.item.id} query={query} />
        </Card>
      ) : (
        <p className="faq-results__hint">
          <Icon name="alertCircle" size={16} /> Não achamos uma resposta exata. Estas são as perguntas mais próximas da sua dúvida:
        </p>
      )}

      {others.length > 0 && (
        <Card title={confident ? "Perguntas parecidas" : "Perguntas mais próximas"} count={others.length} flush>
          <div className="faq-list">
            {others.map((h) => (
              <FaqRow key={h.item.id} item={h.item} stems={stems} query={query} category={catTitle.get(h.item.category_id)} />
            ))}
          </div>
        </Card>
      )}

      <div className="faq-results__foot">
        <span>Não encontrou o que procurava? Fale com a equipe do seu projeto.</span>
        {isClient && <HelpLink />}
        <NotFound query={query} />
      </div>
    </div>
  );
}

function HelpLink() {
  return <Link to="/ajuda" className="btn btn--primary btn--sm"><Icon name="chat" /> Falar com a equipe</Link>;
}

/** Registra a dúvida sem resposta para a administração melhorar o FAQ. */
function NotFound({ query }: { query: string }) {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  if (sent) return <span className="faq-sent"><Icon name="check" size={14} /> Recebemos. Obrigado!</span>;
  return (
    <Button size="sm" variant="outline" icon="flag" loading={busy} onClick={async () => {
      setBusy(true);
      try { await api.faqFeedback(null, false, query); setSent(true); }
      catch (err) { toast((err as Error).message, "error"); }
      finally { setBusy(false); }
    }}>Não encontrei minha dúvida</Button>
  );
}

/* ---------- Navegar por categorias ---------- */
function Browse({ categories, items }: { categories: FaqCategory[]; items: FaqItem[] }) {
  const [cat, setCat] = useState<string | null>(null);
  const byCat = useMemo(() => {
    const m = new Map<string, FaqItem[]>();
    for (const it of items) m.set(it.category_id, [...(m.get(it.category_id) ?? []), it]);
    return m;
  }, [items]);
  const visible = categories.filter((c) => (byCat.get(c.id)?.length ?? 0) > 0);
  const shown = cat ? visible.filter((c) => c.id === cat) : visible;

  return (
    <div className="faq-browse">
      <nav className="faq-cats" aria-label="Categorias">
        <span className="label faq-cats__title">Categorias</span>
        <button type="button" className={cx("faq-cat", !cat && "is-active")} aria-pressed={!cat} onClick={() => setCat(null)}>
          <span>Todas</span><span className="faq-cat__n">{items.length}</span>
        </button>
        {visible.map((c) => (
          <button key={c.id} type="button" className={cx("faq-cat", cat === c.id && "is-active")} aria-pressed={cat === c.id}
            onClick={() => setCat(cat === c.id ? null : c.id)}>
            <span>{c.title}</span><span className="faq-cat__n">{byCat.get(c.id)?.length ?? 0}</span>
          </button>
        ))}
      </nav>
      <div className="stack">
        {shown.map((c) => (
          <Card key={c.id} title={c.title} count={byCat.get(c.id)?.length} flush>
            <div className="faq-list">
              {(byCat.get(c.id) ?? []).map((it) => <FaqRow key={it.id} item={it} stems={null} query={null} />)}
            </div>
          </Card>
        ))}
        <p className="faq-total">{plural(items.length, "pergunta", "perguntas")} em {plural(visible.length, "categoria", "categorias")}.</p>
      </div>
    </div>
  );
}

/* ---------- Pergunta (abre e fecha) ---------- */
function FaqRow({ item, stems, query, category }: { item: FaqItem; stems: Set<string> | null; query: string | null; category?: string }) {
  const [open, setOpen] = useState(false);
  const id = `faq-${item.id}`;
  return (
    <div className={cx("faq-row", open && "is-open")}>
      <button type="button" className="faq-row__q" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="faq-row__text">
          <span><Highlight text={item.question} stems={stems} /></span>
          {category && <span className="faq-row__cat">{category}</span>}
        </span>
        <Icon name="chevronDown" className="icon faq-row__chev" />
      </button>
      {open && (
        <div className="faq-row__a" id={id}>
          <FaqAnswer text={item.answer} />
          <FaqFeedback itemId={item.id} query={query} />
        </div>
      )}
    </div>
  );
}
