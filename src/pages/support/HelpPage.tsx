import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { Button, Card, EmptyState, LoadError, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/utils/format";
import type { SupportOpenResult } from "@/types/domain";
import { TARGET_SHORT } from "./supportUi";

/* ==========================================================================
   Preciso de ajuda: o cliente escolhe o assunto e vai direto para o WhatsApp
   de quem cuida daquilo no projeto. O Customer Success acompanha.
   ========================================================================== */
export function HelpPage() {
  useDocumentTitle("Preciso de ajuda");
  const toast = useToast();
  const wanted = useSearchParam("projeto");
  const q = useAsync(() => api.supportOptions(), []);
  const [project, setProject] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SupportOpenResult | null>(null);

  const projects = q.data?.projects ?? [];
  const categories = q.data?.categories ?? [];
  useEffect(() => {
    if (!q.data || project) return;
    const pick = projects.find((p) => p.id === wanted) ?? (projects.length === 1 ? projects[0] : null);
    if (pick) setProject(pick.id);
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    if (!project || !category) return;
    // A janela abre no clique (senão o navegador bloqueia) e recebe o link quando o registro voltar.
    const win = window.open("", "_blank");
    setBusy(true);
    try {
      const r = await api.supportOpen(project, category, message);
      if (r.url) {
        if (win) { win.opener = null; win.location.href = r.url; } else window.location.href = r.url;
      } else win?.close();
      setDone(r);
    } catch (e) {
      win?.close();
      toast((e as Error).message, "error");
    } finally { setBusy(false); }
  }

  function restart() { setDone(null); setCategory(null); setMessage(""); }

  const head = <PageHead title="Preciso de ajuda" subtitle="Escolha o assunto e fale direto com quem cuida dele no seu projeto, pelo WhatsApp." />;
  if (q.error) return <div className="page help">{head}<LoadError message={q.error} onRetry={() => void q.reload()} /></div>;
  if (q.loading && !q.data) return <div className="page help">{head}<Skeleton height={360} radius={16} /></div>;

  if (projects.length === 0) {
    return (
      <div className="page help">{head}
        <Card><EmptyState icon="folder" title="Você ainda não tem projeto em andamento."
          text="Assim que o seu projeto começar, este canal leva você direto à equipe responsável." /></Card>
      </div>
    );
  }

  if (done) {
    const projectName = projects.find((p) => p.id === project)?.name;
    return (
      <div className="page help">{head}
        <Card className="help-done">
          <span className="help-done__seal" aria-hidden="true"><Icon name={done.url ? "chat" : "check"} size={26} /></span>
          {done.url ? (
            <>
              <h2>Abrimos a conversa com {done.contact_name === "Customer Success" ? "a equipe de Customer Success" : done.contact_name} no WhatsApp</h2>
              <p>A mensagem já vai escrita. É só enviar por lá. Se a conversa não abriu, use o botão abaixo.</p>
              <blockquote className="help-done__msg">{done.text}</blockquote>
              <div className="help-done__actions">
                <a className="btn btn--primary" href={done.url} target="_blank" rel="noopener noreferrer"><Icon name="chat" /> Abrir o WhatsApp</a>
                <Button variant="ghost" onClick={restart}>Pedir ajuda sobre outro assunto</Button>
              </div>
            </>
          ) : (
            <>
              <h2>Recebemos o seu pedido de ajuda</h2>
              <p>Ainda não temos um WhatsApp cadastrado para este assunto{projectName ? ` em ${projectName}` : ""}. A equipe de Customer Success já foi avisada e vai entrar em contato com você.</p>
              <div className="help-done__actions"><Button variant="ghost" onClick={restart}>Pedir ajuda sobre outro assunto</Button></div>
            </>
          )}
          <p className="help-done__cs"><Icon name="headset" size={15} /> A equipe de Customer Success acompanha o seu atendimento e confirma com você se ficou tudo resolvido.</p>
        </Card>
      </div>
    );
  }

  const step = (n: number) => (projects.length > 1 ? n : n - 1);
  return (
    <div className="page help">
      {head}
      <Card className="help-form">
        {projects.length > 1 && (
          <fieldset className="help-step">
            <legend><span className="help-step__n">1</span> Sobre qual projeto?</legend>
            <div className="help-projects" role="radiogroup" aria-label="Projeto">
              {projects.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={project === p.id} className={cx("help-opt", project === p.id && "is-on")} onClick={() => setProject(p.id)}>
                  <Icon name="folder" size={18} />
                  <span><b>{p.name}</b>{p.code && <small>{p.code}</small>}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="help-step">
          <legend><span className="help-step__n">{step(2)}</span> Qual é o assunto?</legend>
          <div className="help-cats" role="radiogroup" aria-label="Assunto">
            {categories.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={category === c.id} className={cx("help-opt help-cat", category === c.id && "is-on")} onClick={() => setCategory(c.id)}>
                <span className="help-cat__check" aria-hidden="true">{category === c.id && <Icon name="check" size={14} />}</span>
                <span>
                  <b>{c.label}</b>
                  {c.description && <small>{c.description}</small>}
                  <em>Você fala com: {c.target === "cs" ? "Customer Success" : `líder de ${TARGET_SHORT[c.target]}`}</em>
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="help-step">
          <legend><span className="help-step__n">{step(3)}</span> Quer adiantar a sua dúvida? <small>(opcional)</small></legend>
          <textarea className="input textarea" rows={3} maxLength={600} value={message} aria-label="Sua dúvida"
            placeholder="Ex.: Gostaria de entender quando sai a próxima entrega." onChange={(e) => setMessage(e.target.value)} />
          <span className="help-count">{message.length}/600</span>
        </fieldset>

        <div className="help-send">
          <p><Icon name="headset" size={15} /> Você será levado ao WhatsApp com a mensagem pronta. A equipe de Customer Success acompanha o atendimento.</p>
          <Button size="lg" icon="chat" loading={busy} disabled={!project || !category} onClick={send}>Falar no WhatsApp</Button>
        </div>
      </Card>
      <p className="help-faq">Prefere ver as respostas mais comuns antes? <Link to="/duvidas" className="link">Dúvidas frequentes</Link></p>
    </div>
  );
}
