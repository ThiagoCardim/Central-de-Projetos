// Busca do FAQ no navegador (≈200 perguntas): o cliente escreve a dúvida com as
// palavras dele e devolvemos as perguntas mais próximas.
//
//   * normaliza acentos e caixa, ignora palavras vazias ("de", "o", "que"...);
//   * reduz as palavras à raiz (aprovação / aprovado / aprovar → "aprov");
//   * pontua estilo BM25 por campo: pergunta pesa mais que palavras-chave,
//     que pesam mais que a resposta;
//   * tolera palavra pela metade (enquanto digita) e erro de digitação leve;
//   * sinônimos comuns do cliente (tempo → prazo, custo → taxa...).
import type { FaqCategory, FaqItem } from "@/types/domain";

const STOP = new Set((
  "a o as os um uma uns umas de da do das dos d em no na nos nas num numa por pelo pela pelos pelas para pra pro pras pros " +
  "com sem e ou que se eu tu ele ela eles elas nos vos voce voces me te lhe meu minha meus minhas seu sua seus suas " +
  "isso isto aquilo esse essa esses essas este esta estes estas aquele aquela qual quais quando como onde porque porq pq " +
  "e eh ser sou sao foi era estar esta estao ter tem tenho ha ao aos mais muito muita ja nao sim tambem so ate apos sobre entre " +
  "faco faz fazer fiz fazem recebi recebemos receber algum alguma alguns algumas quem cada ainda entao la aqui ai bem gostaria queria saber duvida favor ola oi bom dia boa tarde noite"
).split(/\s+/));

/** Verbos genéricos de pergunta: ajudam a ordenar, mas não provam que a dúvida foi entendida. */
const WEAK = new Set(["poss", "pod", "pode", "precis", "dev", "consig", "quer", "quero", "tenh", "sab", "sei", "dizer", "significa", "signific", "acontec"]);

/** Sinônimos que o cliente costuma usar → palavras do FAQ (comparados pela raiz). */
const SYNONYM_WORDS: Record<string, string[]> = {
  tempo: ["prazo"], demora: ["prazo"], demorar: ["prazo"], dias: ["prazo"], meses: ["prazo"], rapido: ["prazo", "andamento"],
  custo: ["taxa", "valor"], valor: ["taxa", "custo"], pagar: ["taxa", "pagamento"], cobranca: ["taxa"], caro: ["custo", "taxa"], cara: ["custo", "taxa"], barato: ["custo"], preco: ["custo", "taxa", "valor"], boleto: ["taxa", "pagamento"],
  prefeitura: ["orgao", "aprovacao"], orgao: ["prefeitura"], licenca: ["alvara", "aprovacao"], alvara: ["licenca", "aprovacao"],
  escritura: ["matricula", "documento"], registro: ["matricula", "cartorio"], cartorio: ["matricula", "registro"],
  lote: ["terreno"], terreno: ["lote"], topografia: ["levantamento", "planialtimetrico"], topografico: ["levantamento", "planialtimetrico"],
  engenheiro: ["rt", "tecnico"], arquiteto: ["rrt", "projeto"], responsavel: ["rt"],
  mudar: ["alterar", "alteracao"], mudanca: ["alteracao"], trocar: ["alterar"], alterar: ["mudanca"],
  atraso: ["prazo", "andamento"], atrasado: ["prazo", "andamento"], parado: ["andamento"], status: ["andamento", "etapa"], acompanhar: ["andamento"],
  comunique: ["exigencia"], notificacao: ["exigencia"], pendencia: ["exigencia"], correcao: ["exigencia"], papel: ["documento"], papeis: ["documentos"],
  obra: ["execucao"], construcao: ["execucao", "obra"], foto: ["documento", "digital"], celular: ["foto", "digital"],
  vizinho: ["confrontante"], vizinhos: ["confrontantes"], divisa: ["confrontante", "limite"], medida: ["area", "dimensao"],
};
let SYNONYMS: Map<string, string[]> | null = null;
function synonymsOf(s: string): string[] {
  if (!SYNONYMS) {
    SYNONYMS = new Map();
    for (const [k, vs] of Object.entries(SYNONYM_WORDS)) {
      const key = stem(k);
      SYNONYMS.set(key, [...new Set([...(SYNONYMS.get(key) ?? []), ...vs.map(stem)])]);
    }
  }
  return SYNONYMS.get(s) ?? [];
}

export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const SUFFIXES = [
  "amentos", "imentos", "amento", "imento", "acoes", "icoes", "ucoes", "acao", "icao", "ucao", "adoras", "adores", "adora", "ador",
  "encias", "ancias", "encia", "ancia", "idades", "idade", "mente", "aveis", "iveis", "avel", "ivel",
  "ados", "idos", "adas", "idas", "ado", "ido", "ada", "ida", "ando", "endo", "indo", "aram", "eram", "iram",
  "ar", "er", "ir", "es", "os", "as", "a", "o", "e", "s",
];

/** Raiz leve em português (determinística, sem dicionário). */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let t = w;
  if (t.endsWith("oes") || t.endsWith("aes")) t = t.slice(0, -3) + "ao";
  else if (t.endsWith("ais")) t = t.slice(0, -3) + "al";
  else if (t.endsWith("eis")) t = t.slice(0, -3) + "el";
  for (const suf of SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= (suf.length >= 4 ? 4 : 3)) { t = t.slice(0, -suf.length); break; }
  }
  return t;
}

/** Palavras (normalizadas) de um texto, sem as vazias. */
export function words(s: string): string[] {
  return normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}
const tokens = (s: string) => words(s).map(stem);

function lev(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

type Field = "q" | "k" | "c" | "a";
const WEIGHT: Record<Field, number> = { q: 3, k: 2.2, c: 0.8, a: 0.7 };
const K1 = 1.2;
const B = 0.6;

interface Doc { item: FaqItem; tf: Record<Field, Map<string, number>>; len: Record<Field, number>; qSeq: string[] }

export interface FaqHit { item: FaqItem; score: number; coverage: number; matched: Set<string> }

export interface FaqIndex {
  search: (query: string, limit?: number) => FaqHit[];
  /** Raízes da consulta (para destacar palavras na pergunta). */
  queryStems: (query: string) => Set<string>;
}

export function buildIndex(items: FaqItem[], categories: FaqCategory[]): FaqIndex {
  const catTitle = new Map(categories.map((c) => [c.id, c.title]));
  const df = new Map<string, number>();
  const sum: Record<Field, number> = { q: 0, k: 0, c: 0, a: 0 };
  const docs: Doc[] = items.map((item) => {
    const fields: Record<Field, string[]> = {
      q: tokens(item.question),
      k: tokens(item.keywords ?? ""),
      c: tokens(catTitle.get(item.category_id) ?? ""),
      a: tokens(item.answer),
    };
    const tf = { q: new Map(), k: new Map(), c: new Map(), a: new Map() } as Doc["tf"];
    const seen = new Set<string>();
    (Object.keys(fields) as Field[]).forEach((f) => {
      for (const t of fields[f]) { tf[f].set(t, (tf[f].get(t) ?? 0) + 1); seen.add(t); }
      sum[f] += fields[f].length;
    });
    seen.forEach((t) => df.set(t, (df.get(t) ?? 0) + 1));
    return { item, tf, len: { q: fields.q.length, k: fields.k.length, c: fields.c.length, a: fields.a.length }, qSeq: fields.q };
  });
  const N = Math.max(docs.length, 1);
  const avg: Record<Field, number> = { q: sum.q / N || 1, k: sum.k / N || 1, c: sum.c / N || 1, a: sum.a / N || 1 };
  const vocab = [...df.keys()];
  const idf = (t: string) => { const n = df.get(t) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };

  /** Cada palavra da consulta vira um grupo de termos do índice com peso (exato, sinônimo, prefixo, erro de digitação). */
  function expand(query: string): { groups: Map<string, number>[]; stems: Set<string>; refs: number[] } {
    const raw = words(query);
    const groups: Map<string, number>[] = [];
    const refs: number[] = [];
    const stems = new Set<string>();
    raw.forEach((w, i) => {
      const s = stem(w);
      const g = new Map<string, number>();
      const add = (t: string, wgt: number) => { if (df.has(t) && (g.get(t) ?? 0) < wgt) g.set(t, wgt); };
      add(s, 1);
      if (s !== w) add(w, 1);
      const exact = g.size > 0;
      for (const syn of synonymsOf(s)) add(syn, 0.8);
      const isLast = i === raw.length - 1;
      const known = g.size > 0;
      if (exact ? isLast && w.length <= 4 : !known && ((isLast && w.length >= 4) || s.length >= 5)) {
        // palavra pela metade (ainda digitando) ou raiz mais longa no índice
        const pre = s.length >= 4 ? s : w;
        for (const t of vocab) if (t !== s && t.startsWith(pre)) add(t, exact ? 0.4 : isLast ? 0.8 : 0.6);
        // ou a palavra digitada já passou da raiz ("levantamen" → "levant")
        if (!exact) for (const t of vocab) if (t.length >= 4 && s.startsWith(t)) add(t, 0.75);
      }
      if (!known && s.length >= 4) {
        const max = s.length >= 8 ? 2 : 1;
        for (const t of vocab) if (Math.abs(t.length - s.length) <= max && lev(s, t, max) <= max) add(t, 0.7);
      }
      g.forEach((_, t) => stems.add(t));
      stems.add(s);
      // peso de referência da palavra (para medir quanto da dúvida foi coberto):
      // o termo exato quando existe; senão o melhor alternativo; palavra desconhecida pesa pouco
      const ref = WEAK.has(s) ? 0 : exact ? idf(s) || idf(w) : g.size ? Math.max(...[...g].map(([t, wg]) => idf(t) * wg)) : 2;
      groups.push(g);
      refs.push(ref);
    });
    return { groups, stems, refs };
  }

  function search(query: string, limit = 8): FaqHit[] {
    const { groups, refs } = expand(query);
    if (groups.length === 0) return [];
    const totalIdf = Math.max(refs.reduce((acc, r) => acc + r, 0), 0.1);
    const hits: FaqHit[] = [];
    for (const d of docs) {
      let score = 0;
      let covered = 0;
      let qCovered = 0;
      const matched = new Set<string>();
      groups.forEach((g, gi) => {
        let best = 0;
        let bestIdf = 0;
        let inQ = false;
        g.forEach((wgt, t) => {
          let wtf = 0;
          (Object.keys(WEIGHT) as Field[]).forEach((f) => {
            const tf = d.tf[f].get(t);
            if (tf) wtf += WEIGHT[f] * tf / (1 - B + B * (d.len[f] / avg[f]));
          });
          if (!wtf) return;
          const s = wgt * idf(t) * (wtf * (K1 + 1)) / (wtf + K1);
          if (s > best) { best = s; bestIdf = idf(t) * wgt; inQ = d.tf.q.has(t); }
          matched.add(t);
        });
        if (best > 0) { score += best; covered += Math.min(bestIdf, refs[gi]); if (inQ) qCovered += Math.min(bestIdf, refs[gi]); }
      });
      if (score <= 0) continue;
      // frases: palavras da consulta em sequência dentro da pergunta
      for (let i = 0; i + 1 < groups.length; i++) {
        for (let j = 0; j + 1 < d.qSeq.length; j++) {
          if (groups[i].has(d.qSeq[j]) && groups[i + 1].has(d.qSeq[j + 1])) { score += 1.2; break; }
        }
      }
      const coverage = Math.min(1, covered / totalIdf);
      // a pergunta é um título curado: cobrir a dúvida no título vale mais
      const qCoverage = Math.min(1, qCovered / totalIdf);
      hits.push({ item: d.item, score: score * (0.35 + 0.65 * coverage) * (1 + 0.6 * qCoverage), coverage, matched });
    }
    hits.sort((a, b) => b.score - a.score || a.item.sort_order - b.item.sort_order);
    return hits.slice(0, limit);
  }

  // destaque só nas palavras que distinguem a pergunta (sem "posso", "projeto" e afins)
  const qdf = new Map<string, number>();
  docs.forEach((d) => d.tf.q.forEach((_, t) => qdf.set(t, (qdf.get(t) ?? 0) + 1)));
  const FUNCTION_WORDS = new Set(["depoi", "ant", "antes", "durant", "enquant", "agor", "sempr", "projet", "process"]);
  const distinctive = (t: string) => !WEAK.has(t) && !FUNCTION_WORDS.has(t) && (qdf.get(t) ?? 0) <= Math.max(3, N * 0.08);
  return { search, queryStems: (q) => new Set([...expand(q).stems].filter(distinctive)) };
}

/** A melhor resposta é "confiável" quando cobre boa parte da dúvida. */
export function isConfident(hits: FaqHit[]): boolean {
  if (!hits.length) return false;
  const [a, b] = hits;
  if (a.coverage >= 0.45 && a.score >= 2) return true;
  // destaca-se claramente das demais mesmo com palavras que o FAQ não usa
  return a.score >= 4 && (!b || a.score >= 1.6 * b.score);
}
