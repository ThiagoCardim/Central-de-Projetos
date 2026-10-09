import { useEffect, useRef, useState } from "react";
import { api } from "@/services/api";
import { useAsync } from "@/hooks";
import { Badge, Button, Card, EmptyState, Input, LoadError, Select, Skeleton } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { cx, plural, ROLE_LABEL } from "@/utils/format";
import type { SupportCategory, SupportPerson, SupportTarget } from "@/types/domain";
import { TARGET_LABEL, TARGET_SHORT, TEMPLATE_VARS, formatWhatsapp, previewTemplate, waDigits } from "@/pages/support/supportUi";

/* ==========================================================================
   Configurações › Atendimento ao cliente ("Preciso de ajuda")
   ========================================================================== */
export function SupportSettingsPanel({ tenantId }: { tenantId: string }) {
  const q = useAsync(() => api.supportSettings(tenantId), [tenantId]);
  if (q.error) return <LoadError message={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <Skeleton height={360} radius={16} />;
  const d = q.data;
  const leaders = d.people.filter((p) => p.leads.length > 0);
  const missing = leaders.filter((p) => !p.whatsapp).length;

  return (
    <div className="settings__grid">
      <div className="stack">
        <Card title="WhatsApp da equipe" count={d.people.length || undefined} flush
          action={missing ? <Badge tone="warning" dot>{plural(missing, "líder sem número", "líderes sem número")}</Badge> : undefined}>
          {d.people.length === 0 ? <EmptyState compact icon="users" title="Nenhum líder ou administrador nesta unidade." /> : (
            <ul className="supset__people">
              {d.people.map((p) => <PersonRow key={p.id} p={p} onSaved={() => void q.reload()} />)}
            </ul>
          )}
        </Card>
        <MessageCard tenantId={tenantId} csWhatsapp={d.cs_whatsapp} template={d.message_template} defaultTemplate={d.default_template} onSaved={() => void q.reload()} />
        <CategoriesCard categories={d.categories} editable={d.can_edit_categories} onSaved={() => void q.reload()} />
      </div>
      <aside className="settings__help">
        <h3><Icon name="alertCircle" size={16} /> Como funciona</h3>
        <p>O cliente toca em <b>Preciso de ajuda</b>, escolhe o assunto e é levado ao WhatsApp de quem cuida daquilo <b>no projeto dele</b>: o líder de Arquitetura, Engenharia ou Aprovação definido na equipe do projeto.</p>
        <p>Se o líder não tiver WhatsApp cadastrado, a conversa vai para o <b>WhatsApp do Customer Success</b>. Sem nenhum dos dois, o CS é avisado para entrar em contato.</p>
        <p>Todo pedido vira um atendimento na aba <b>Customer Success › Pedidos de ajuda</b>, para o CS confirmar com o cliente se foi resolvido.</p>
      </aside>
    </div>
  );
}

function PersonRow({ p, onSaved }: { p: SupportPerson; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState(p.whatsapp ? formatWhatsapp(p.whatsapp) : "");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const original = p.whatsapp ? formatWhatsapp(p.whatsapp) : "";
  useEffect(() => { setV(original); setTouched(false); }, [original]);
  const digits = waDigits(v);
  const dirty = (digits ?? (v.trim() ? "?" : "")) !== (p.whatsapp ?? "");
  const invalid = v.trim() !== "" && !digits;

  async function save() {
    if (invalid) return;
    setBusy(true);
    try { await api.setPersonWhatsapp(p.id, v.trim() || null); toast(v.trim() ? `WhatsApp de ${p.name.split(" ")[0]} salvo.` : `WhatsApp de ${p.name.split(" ")[0]} removido.`); onSaved(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  return (
    <li className="supset__person">
      <div className="supset__who">
        <b>{p.name}</b>
        <span className="supset__role">
          {ROLE_LABEL[p.role]}
          {p.leads.length > 0 && <> · lidera {p.leads.map((t) => TARGET_SHORT[t]).join(", ")} em {plural(p.projects_led, "projeto", "projetos")}</>}
        </span>
      </div>
      <form className="supset__wa" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Input aria-label={`WhatsApp de ${p.name}`} inputMode="tel" placeholder="(35) 99999-0000" value={v} maxLength={24}
          aria-invalid={invalid || undefined} className={cx(!p.whatsapp && p.leads.length > 0 && !v && "is-missing")} onBlur={() => setTouched(true)} onChange={(e) => setV(e.target.value)} />
        {dirty && <Button size="sm" type="submit" icon="check" loading={busy} disabled={invalid}>Salvar</Button>}
      </form>
      {invalid && touched && <span className="field__error supset__err">Informe DDD e número.</span>}
    </li>
  );
}

function MessageCard({ tenantId, csWhatsapp, template, defaultTemplate, onSaved }: {
  tenantId: string; csWhatsapp: string | null; template: string; defaultTemplate: string; onSaved: () => void;
}) {
  const toast = useToast();
  const [cs, setCs] = useState(csWhatsapp ? formatWhatsapp(csWhatsapp) : "");
  const [tpl, setTpl] = useState(template);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setCs(csWhatsapp ? formatWhatsapp(csWhatsapp) : ""); setTpl(template); }, [csWhatsapp, template]);

  const csInvalid = cs.trim() !== "" && !waDigits(cs);
  const tplInvalid = tpl.trim().length < 10 ? "Escreva a mensagem (mínimo de 10 caracteres)." : tpl.length > 600 ? "Use no máximo 600 caracteres." : null;
  const dirty = (waDigits(cs) ?? "") !== (csWhatsapp ?? "") || tpl.trim() !== template.trim();

  function insert(key: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? tpl.length; const end = el?.selectionEnd ?? tpl.length;
    const next = tpl.slice(0, start) + key + tpl.slice(end);
    setTpl(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + key.length, start + key.length); });
  }
  async function save() {
    setBusy(true);
    try { await api.supportSettingsSave(tenantId, cs.trim() || null, tpl); toast("Atendimento ao cliente atualizado."); onSaved(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <Card title="Mensagem e Customer Success">
      <div className="stack supset__msg">
        <label className="field">
          <span className="field__label">WhatsApp do Customer Success</span>
          <Input inputMode="tel" placeholder="(35) 99999-0000" value={cs} maxLength={24} aria-invalid={csInvalid || undefined} onChange={(e) => setCs(e.target.value)} />
          {csInvalid ? <span className="field__error">Informe DDD e número.</span>
            : <span className="field__hint">Recebe os assuntos de prazos e andamento e os pedidos quando o líder não tem WhatsApp cadastrado.</span>}
        </label>
        <div className="field">
          <label className="field__label" htmlFor="supset-tpl">Mensagem que já vai escrita no WhatsApp</label>
          <textarea id="supset-tpl" ref={ref} className="input textarea" rows={4} maxLength={600} value={tpl} onChange={(e) => setTpl(e.target.value)} />
          <div className="supset__vars" role="group" aria-label="Inserir informação">
            {TEMPLATE_VARS.map((v) => (
              <button key={v.key} type="button" className="faq-chip" title={v.label} onClick={() => insert(v.key)}><code>{v.key}</code> {v.label}</button>
            ))}
          </div>
          {tplInvalid && <span className="field__error">{tplInvalid}</span>}
        </div>
        <div className="supset__preview">
          <span className="label">Prévia</span>
          <div className="supset__bubble">{previewTemplate(tpl)}</div>
          <span className="subtext">Se o cliente não escrever nada, o trecho de {"{mensagem}"} fica de fora.</span>
        </div>
        <div className="settings__save">
          {tpl.trim() !== defaultTemplate && <Button variant="ghost" icon="refresh" onClick={() => setTpl(defaultTemplate)}>Usar mensagem padrão</Button>}
          <Button icon="check" loading={busy} disabled={!dirty || csInvalid || !!tplInvalid} onClick={save}>Salvar</Button>
        </div>
      </div>
    </Card>
  );
}

const TARGETS: SupportTarget[] = ["architecture", "engineering", "approval", "cs"];

function CategoriesCard({ categories, editable, onSaved }: { categories: SupportCategory[]; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState<{ id: string | null; label: string; description: string; target: SupportTarget; active: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(c = editing) {
    if (!c || c.label.trim().length < 2) return;
    setBusy(true);
    try { await api.supportCategorySave(c); toast(c.id ? "Assunto atualizado." : "Assunto incluído."); setEditing(null); onSaved(); }
    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }
  const form = editing && (
    <form className="supset__catform" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Input aria-label="Assunto" placeholder="Assunto (ex.: Engenharia)" autoFocus value={editing.label} maxLength={80} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
      <Input aria-label="Descrição" placeholder="Exemplos para o cliente (opcional)" value={editing.description} maxLength={200} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
      <Select aria-label="Quem atende" value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value as SupportTarget })}>
        {TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABEL[t]}</option>)}
      </Select>
      <div className="row">
        <Button size="sm" type="submit" icon="check" loading={busy} disabled={editing.label.trim().length < 2}>Salvar</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancelar</Button>
      </div>
    </form>
  );

  return (
    <Card title="Assuntos que o cliente escolhe" count={categories.filter((c) => c.active).length || undefined} flush
      action={!editable ? <span className="subtext">Definidos pela franqueadora</span> : undefined}>
      <ul className="supset__cats">
        {categories.map((c) => editing?.id === c.id ? <li key={c.id} className="supset__cat">{form}</li> : (
          <li key={c.id} className={cx("supset__cat", !c.active && "is-off")}>
            <div className="grow">
              <b>{c.label}</b>{!c.active && <Badge>Oculto</Badge>}
              {c.description && <small>{c.description}</small>}
            </div>
            <span className="supset__target"><Icon name="chat" size={13} /> {TARGET_LABEL[c.target]}</span>
            {editable && (
              <span className="sector__actions">
                <Button size="sm" variant="ghost" iconOnly icon="edit" onClick={() => setEditing({ id: c.id, label: c.label, description: c.description ?? "", target: c.target, active: c.active ?? true })}>Editar {c.label}</Button>
                <Button size="sm" variant="ghost" iconOnly icon={c.active ? "eye" : "plus"} onClick={() => save({ id: c.id, label: c.label, description: c.description ?? "", target: c.target, active: !c.active })}>
                  {c.active ? `Ocultar ${c.label}` : `Mostrar ${c.label}`}</Button>
              </span>
            )}
          </li>
        ))}
        {editing?.id === null && <li className="supset__cat">{form}</li>}
      </ul>
      {editable && !editing && (
        <div className="supset__add"><Button size="sm" variant="outline" icon="plus" onClick={() => setEditing({ id: null, label: "", description: "", target: "cs", active: true })}>Incluir assunto</Button></div>
      )}
    </Card>
  );
}
