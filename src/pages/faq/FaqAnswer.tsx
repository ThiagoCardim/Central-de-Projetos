// Renderização das respostas do FAQ (marcação simples, sem HTML do banco):
//   parágrafos separados por linha em branco · "- " lista · "1. " lista numerada · *destaque*
import { Fragment, useState, type ReactNode } from "react";
import { api } from "@/services/api";
import { useToast } from "@/components/ui/overlays";
import { Button } from "@/components/ui/primitives";
import { normalize, stem, words } from "./faqSearch";

function inline(text: string, key: string): ReactNode[] {
  // *texto* → ênfase; o restante é texto puro (React escapa)
  return text.split(/(\*[^*\n]+\*)/g).filter(Boolean).map((part, i) =>
    part.length > 2 && part.startsWith("*") && part.endsWith("*")
      ? <em key={`${key}-${i}`}>{part.slice(1, -1)}</em>
      : <Fragment key={`${key}-${i}`}>{part}</Fragment>,
  );
}

export function FaqAnswer({ text }: { text: string }) {
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return (
    <div className="faq-answer">
      {blocks.map((b, i) => {
        const lines = b.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.every((l) => /^[-•]\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^[-•]\s+/, ""), `${i}-${j}`)}</li>)}</ul>;
        }
        if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
          return <ol key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\d+[.)]\s+/, ""), `${i}-${j}`)}</li>)}</ol>;
        }
        // parágrafo inteiro em destaque vira nota
        if (lines.length === 1 && /^\*[^*]+\*$/.test(lines[0])) {
          return <p key={i} className="faq-answer__note">{lines[0].slice(1, -1)}</p>;
        }
        return <p key={i}>{lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inline(l, `${i}-${j}`)}</Fragment>)}</p>;
      })}
    </div>
  );
}

/** Destaca na pergunta as palavras que casaram com a dúvida escrita. */
export function Highlight({ text, stems }: { text: string; stems: Set<string> | null }) {
  if (!stems || stems.size === 0) return <>{text}</>;
  const parts = text.split(/([\p{L}\p{N}]+)/u);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{p}</Fragment>;
        const w = words(p)[0];
        const hit = w && (stems.has(stem(w)) || stems.has(normalize(p)));
        return hit ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>;
      })}
    </>
  );
}

/** "Isso respondeu sua dúvida?" — registra o retorno para a administração. */
export function FaqFeedback({ itemId, query }: { itemId: string; query: string | null }) {
  const toast = useToast();
  const [sent, setSent] = useState<"yes" | "no" | null>(null);
  const [busy, setBusy] = useState(false);
  async function send(helpful: boolean) {
    setBusy(true);
    try { await api.faqFeedback(itemId, helpful, query); setSent(helpful ? "yes" : "no"); }
    catch (err) { toast((err as Error).message, "error"); }
    finally { setBusy(false); }
  }
  if (sent === "yes") return <p className="faq-fb faq-fb--done">Que bom! Obrigado pelo retorno.</p>;
  if (sent === "no") {
    return (
      <p className="faq-fb faq-fb--done">
        Obrigado. Vamos usar isso para melhorar as respostas. Se a dúvida continuar, fale com a equipe do seu projeto.
      </p>
    );
  }
  return (
    <div className="faq-fb">
      <span>Isso respondeu sua dúvida?</span>
      <Button size="sm" variant="secondary" icon="check" disabled={busy} onClick={() => send(true)}>Sim</Button>
      <Button size="sm" variant="ghost" icon="x" disabled={busy} onClick={() => send(false)}>Não</Button>
    </div>
  );
}
