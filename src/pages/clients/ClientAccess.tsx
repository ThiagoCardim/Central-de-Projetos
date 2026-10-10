import { useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Avatar, Badge, Button, Card, Input, Segmented, Skeleton } from "@/components/ui/primitives";
import { Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, plural } from "@/utils/format";
import type { ClientAccessPerson, ProjectClientAccess } from "@/types/domain";

/* ==========================================================================
   Acessos do cliente por projeto: quem do lado do cliente vê o projeto, se
   decide (aprova, pede revisão, envia documentos) ou só acompanha.
   As regras de verdade estão no banco (private.client_access_*).
   ========================================================================== */
const RELATIONS = ["Proprietário(a)", "Cônjuge", "Sócio(a)", "Familiar", "Arquiteto(a) parceiro(a)", "Engenheiro(a) da obra", "Financeiro", "Assistente"];

function scopeText(x: ClientAccessPerson) {
  if (x.scope === "all") return "Todos os projetos";
  return x.projects && x.projects > 1 ? `${x.projects} projetos` : "Só este projeto";
}

export function ClientAccessCard({ projectId, client = false }: { projectId: string; client?: boolean }) {
  const toast = useToast();
  const q = useAsync(() => api.projectClientAccess(projectId), [projectId]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientAccessPerson | null>(null);
  const [removing, setRemoving] = useState<ClientAccessPerson | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const d = q.data;
  const reload = () => void q.reload();

  async function resend(x: ClientAccessPerson) {
    setResending(x.id);
    try { await api.clientAccessResend(projectId, x.id); toast(`Convite reenviado para ${x.email ?? x.name}.`); }
    catch (e) { toast((e as Error).message, "error"); } finally { setResending(null); }
  }

  if (q.error) return null;
  return (
    <Card className="caccess" title={client ? (d ? `Quem acompanha ${d.project.name}` : "Quem acompanha o projeto") : "Acessos do cliente"}
      count={d?.people.length || undefined}
      action={d?.can_manage && <Button size="sm" variant="secondary" icon="userPlus" onClick={() => setAdding(true)}>Adicionar pessoa</Button>}>
      {!d ? <Skeleton height={64} radius={10} /> : (
        <>
          {d.people.length === 0 ? <p className="subtext">Ninguém do cliente tem acesso a este projeto ainda.</p> : (
            <ul className="caccess__list">
              {d.people.map((x) => (
                <li key={x.id} className={cx("caccess__row", x.status === "pending" && "is-pending")}>
                  <Avatar name={x.name} size="sm" />
                  <div className="grow caccess__who">
                    <span className="caccess__name">
                      <b>{x.name}</b>{x.is_me && <span className="muted"> (você)</span>}
                      {x.relation && <span className="muted"> · {x.relation}</span>}
                    </span>
                    {x.email && <span className="subtext truncate">{x.email}</span>}
                    <span className="caccess__tags">
                      {x.is_primary && <Badge tone="brand" outline>Contato principal</Badge>}
                      {x.can_decide ? <Badge outline>Decide</Badge> : <Badge outline>Só acompanha</Badge>}
                      <span className="muted">{scopeText(x)}</span>
                      {x.status === "pending" && <Badge tone="warning" dot>Convite pendente</Badge>}
                      {x.status === "inactive" && <Badge tone="danger" dot>Acesso desativado</Badge>}
                    </span>
                  </div>
                  {d.can_manage && (
                    <div className="caccess__actions">
                      {x.status === "pending" && (
                        <Button size="sm" variant="ghost" iconOnly icon="mail" title="Reenviar convite" loading={resending === x.id} onClick={() => resend(x)}>Reenviar convite para {x.name}</Button>
                      )}
                      {x.can_edit && <Button size="sm" variant="ghost" iconOnly icon="edit" onClick={() => setEditing(x)}>Editar acesso de {x.name}</Button>}
                      {x.can_edit && <Button size="sm" variant="ghost" iconOnly icon="x" onClick={() => setRemoving(x)}>Remover acesso de {x.name}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="subtext caccess__hint">
            <b>Decide:</b> aprova entregas, pede revisões, envia documentos e responde às perguntas. <b>Só acompanha:</b> vê o andamento e as entregas e baixa os arquivos.
            {client && !d.can_manage ? " Para incluir alguém, fale com o contato principal do projeto ou com a equipe." : ""}
          </p>
        </>
      )}
      {adding && d && <AddModal d={d} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {editing && d && <EditModal d={d} x={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
      {removing && d && <RemoveModal d={d} x={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); reload(); }} />}
    </Card>
  );
}

function LevelField({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="field">
      <span className="field__label">O que a pessoa pode fazer</span>
      <Segmented<"decide" | "follow"> label="Nível de acesso" value={value ? "decide" : "follow"} onChange={(v) => onChange(v === "decide")}
        options={[{ value: "decide", label: "Decide" }, { value: "follow", label: "Só acompanha" }]} />
      <span className="field__hint">{value
        ? "Aprova entregas, pede revisões, envia documentos e responde às perguntas do projeto."
        : "Vê o andamento, o cronograma e as entregas, e baixa os arquivos. Não aprova nem envia nada."}</span>
    </div>
  );
}

function ScopeField({ d, value, onChange }: { d: ProjectClientAccess; value: boolean; onChange: (v: boolean) => void }) {
  if (!d.can_grant_all) return null;
  return (
    <label className="pset__check">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span><b>Todos os projetos de {d.project.client_name ?? "este cliente"}</b>
        <small>{d.other_projects > 0 ? `Inclui ${plural(d.other_projects, "outro projeto", "outros projetos")} e os próximos.` : "Inclui os próximos projetos deste cliente."} Sem marcar, vale só para {d.project.name}.</small></span>
    </label>
  );
}

function AddModal({ d, onClose, onDone }: { d: ProjectClientAccess; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: "", email: "", phone: "", relation: "", all: false, decide: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim());
  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.clientAccessAdd({ project_id: d.project.id, name: f.name.trim(), email: f.email, phone: f.phone.trim() || null,
        relation: f.relation.trim() || null, all_projects: f.all, can_decide: f.decide });
      toast(r.invited ? `Convite enviado para ${f.email.trim().toLowerCase()}.` : `${f.name.trim() || f.email.trim()} já tem login e agora vê o projeto.`);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Adicionar pessoa a ${d.project.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button icon="userPlus" loading={busy} disabled={!emailOk || f.name.trim().length < 2} onClick={save}>Dar acesso</Button></>}>
      <div className="stack">
        <p className="subtext">Se o e-mail ainda não tem login no portal, a pessoa recebe um convite para criar a senha. Se já tem, o projeto aparece para ela na hora.</p>
        <div className="caccess__grid">
          <label className="field">
            <span className="field__label">Nome</span>
            <Input value={f.name} maxLength={120} autoFocus placeholder="Nome completo" onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">E-mail</span>
            <Input type="email" value={f.email} placeholder="nome@email.com" onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Telefone <small>(opcional)</small></span>
            <Input value={f.phone} inputMode="tel" placeholder="(11) 99999-0000" onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Quem é <small>(opcional)</small></span>
            <Input value={f.relation} maxLength={60} list="caccess-relations" placeholder="Ex.: Cônjuge, Sócio(a)" onChange={(e) => setF({ ...f, relation: e.target.value })} />
            <datalist id="caccess-relations">{RELATIONS.map((r) => <option key={r} value={r} />)}</datalist>
          </label>
        </div>
        <LevelField value={f.decide} onChange={(v) => setF({ ...f, decide: v })} />
        <ScopeField d={d} value={f.all} onChange={(v) => setF({ ...f, all: v })} />
        {err && <p className="dlvnote is-error"><Icon name="alertCircle" size={16} /><span>{err}</span></p>}
      </div>
    </Modal>
  );
}

function EditModal({ d, x, onClose, onDone }: { d: ProjectClientAccess; x: ClientAccessPerson; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [relation, setRelation] = useState(x.relation ?? "");
  const [decide, setDecide] = useState(x.can_decide);
  const [all, setAll] = useState(x.scope === "all");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.clientAccessUpdate(d.project.id, x.id, relation, all, decide); toast("Acesso atualizado."); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Acesso de ${x.name}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button icon="check" loading={busy} onClick={save}>Salvar</Button></>}>
      <div className="stack">
        <label className="field">
          <span className="field__label">Quem é <small>(opcional)</small></span>
          <Input value={relation} maxLength={60} list="caccess-relations-e" onChange={(e) => setRelation(e.target.value)} />
          <datalist id="caccess-relations-e">{RELATIONS.map((r) => <option key={r} value={r} />)}</datalist>
        </label>
        <LevelField value={decide} onChange={setDecide} />
        {x.scope === "projects" && x.projects && x.projects > 1 && <p className="subtext">O nível vale para todos os projetos que {x.name.split(" ")[0]} acompanha deste cliente.</p>}
        {d.can_grant_all ? <ScopeField d={d} value={all} onChange={setAll} />
          : x.scope === "all" && <p className="subtext">Esta pessoa vê todos os projetos do cliente.</p>}
      </div>
    </Modal>
  );
}

function RemoveModal({ d, x, onClose, onDone }: { d: ProjectClientAccess; x: ClientAccessPerson; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const several = x.scope === "all" ? d.other_projects > 0 : (x.projects ?? 1) > 1;
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.clientAccessRemove(d.project.id, x.id, all || !several); toast(`${x.name} não tem mais acesso${all || !several ? "" : " a este projeto"}.`); onDone(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`Remover o acesso de ${x.name}?`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="danger" loading={busy} onClick={save}>Remover acesso</Button></>}>
      <div className="stack">
        <p>{x.name} deixa de ver {several && !all ? d.project.name : "os projetos deste cliente"} e de receber avisos. O login continua existindo; dá para incluir de novo depois.</p>
        {several && (
          <div className="caccess__remove">
            <label className="pset__check"><input type="radio" name="rm" checked={!all} onChange={() => setAll(false)} />
              <span><b>Só deste projeto</b><small>Continua nos outros projetos que acompanha.</small></span></label>
            <label className="pset__check"><input type="radio" name="rm" checked={all} onChange={() => setAll(true)} />
              <span><b>De todos os projetos do cliente</b></span></label>
          </div>
        )}
      </div>
    </Modal>
  );
}
