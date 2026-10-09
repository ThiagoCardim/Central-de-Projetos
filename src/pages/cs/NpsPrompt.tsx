import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { Button } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, formatDate } from "@/utils/format";
import type { NpsPending } from "@/types/domain";

/* ==========================================================================
   Pesquisa NPS do cliente: comemora o serviço concluído e pede a nota
   ========================================================================== */
const SCALE = Array.from({ length: 11 }, (_, i) => i);
const scoreClass = (n: number) => (n <= 6 ? "is-low" : n <= 8 ? "is-mid" : "is-high");

export function NpsPrompt() {
  const toast = useToast();
  const [queue, setQueue] = useState<NpsPending[]>([]);
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"send" | "later" | "never" | null>(null);
  const [thanks, setThanks] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    // Pequena espera para não competir com o carregamento da página.
    const t = setTimeout(() => { api.npsPending().then((xs) => { if (alive) setQueue(xs); }).catch(() => undefined); }, 600);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  const cur = queue[0];
  function next() { setQueue((q) => q.slice(1)); setScore(null); setComment(""); setThanks(null); }

  async function send() {
    if (!cur || score == null) return;
    setBusy("send");
    try { await api.npsAnswer(cur.project_service_id, score, comment); setThanks(score); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }
  async function skip(mode: "later" | "never") {
    if (!cur) return;
    setBusy(mode);
    try { await api.npsSkip(cur.project_service_id, mode); next(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
  }

  if (!cur) return null;

  if (thanks != null) {
    return (
      <Modal open onClose={next} title="Obrigado pela avaliação!"
        footer={<Button onClick={next}>{queue.length > 1 ? "Próxima avaliação" : "Fechar"}</Button>}>
        <div className="nps nps--thanks">
          <span className="nps__seal" aria-hidden="true"><Icon name="check" size={28} /></span>
          <p>{thanks >= 9 ? "Que bom que você gostou! Seguimos juntos nas próximas etapas." : thanks >= 7
            ? "Sua opinião ajuda a gente a melhorar a cada entrega."
            : "Sentimos muito que não foi como esperado. Nossa equipe de Customer Success vai entrar em contato para entender melhor."}</p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={() => void skip("later")} wide title={`${cur.service_name} concluído`}
      footer={<>
        <button type="button" className="nps__never" disabled={!!busy} onClick={() => skip("never")}>Não quero responder</button>
        <Button variant="ghost" loading={busy === "later"} onClick={() => skip("later")}>Responder depois</Button>
        <Button icon="check" loading={busy === "send"} disabled={score == null} onClick={send}>Enviar avaliação</Button>
      </>}>
      <div className="nps">
        <div className="nps__hero" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => <span key={i} className="nps__confetti" style={{ ["--i" as string]: i }} />)}
          <span className="nps__seal"><Icon name="trophy" size={30} /></span>
        </div>
        <div className="nps__intro">
          <h3>Parabéns! Todas as etapas foram concluídas.</h3>
          <p><b>{cur.service_name}</b> do projeto <b>{cur.project_name}</b> foi finalizado em {formatDate(cur.completed_on, true)}. Obrigado por confiar na YouCon.</p>
        </div>
        <fieldset className="nps__q">
          <legend>{cur.question}</legend>
          <div className="nps__scale" role="radiogroup" aria-label="Nota de 0 a 10">
            {SCALE.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={score === n} className={cx("nps__n", scoreClass(n), score === n && "is-on")}
                onClick={() => setScore(n)}>{n}</button>
            ))}
          </div>
          <div className="nps__ends"><span>Nada provável</span><span>Muito provável</span></div>
        </fieldset>
        {score != null && (
          <label className="nps__comment">
            <span>{score >= 9 ? "O que mais você gostou?" : score >= 7 ? "O que faltou para ser nota 10?" : "O que não saiu como você esperava?"} <small>(opcional)</small></span>
            <textarea className="input textarea" rows={3} maxLength={2000} value={comment} autoFocus onChange={(e) => setComment(e.target.value)} />
          </label>
        )}
      </div>
    </Modal>
  );
}
