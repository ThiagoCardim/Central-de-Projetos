import { useEffect, useId, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, LoadError, SearchInput, Segmented, Select, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type {
  CatalogService, ClientType, DurationType, ScheduleTemplate, ServiceFamily, TaskLibraryItem, TemplateDependency, TemplateTask,
} from "@/types/domain";
import { cx, formatDate, plural } from "@/utils/format";
import { DURATION_TYPE_LABEL } from "@/pages/schedule/model";

type Tab = "templates" | "library";

export function TemplatesPage() {
  useDocumentTitle("Serviços e Cronogramas");
  const { permissions } = useAuth();
  const canEdit = !!permissions?.can_manage_templates;
  const [tab, setTab] = useState<Tab>("templates");
  return (
    <div className="page">
      <PageHead title="Serviços e Cronogramas"
        subtitle={canEdit
          ? "Gerenciador de Templates YouCon. Alterar o padrão cria uma nova versão; projetos já iniciados continuam com a versão que usaram."
          : "Padrões de cronograma da YouCon e biblioteca de etapas. Somente o ADM Global altera os padrões."} />
      <Tabs<Tab> label="Seções" value={tab} onChange={setTab} tabs={[
        { value: "templates", label: "Padrões YouCon" },
        { value: "library", label: "Biblioteca de etapas" },
      ]} />
      {tab === "templates" ? <TemplatesManager canEdit={canEdit} /> : <LibraryManager />}
    </div>
  );
}

/* ==========================================================================
   Padrões
   ========================================================================== */
function variantKey(t: Pick<ScheduleTemplate, "client_type" | "area_min" | "area_max">) {
  return `${t.client_type ?? "all"}|${t.area_min ?? ""}|${t.area_max ?? ""}`;
}
function variantLabel(t: Pick<ScheduleTemplate, "client_type" | "area_min" | "area_max">) {
  const parts: string[] = [];
  parts.push(t.client_type ? t.client_type.toUpperCase() : "B2C e B2B");
  if (t.area_min != null && t.area_max != null) parts.push(`${t.area_min}–${t.area_max} m²`);
  else if (t.area_max != null) parts.push(`até ${t.area_max} m²`);
  else if (t.area_min != null) parts.push(`acima de ${t.area_min} m²`);
  return parts.join(" · ");
}

function TemplatesManager({ canEdit }: { canEdit: boolean }) {
  const mobile = useIsMobile();
  const catalog = useAsync(() => api.listCatalog(), []);
  const [family, setFamily] = useState<string | null>(null);
  const [service, setService] = useState<string | null>(null);

  useEffect(() => {
    if (!catalog.data || family) return;
    setFamily(catalog.data.families[0]?.id ?? null);
  }, [catalog.data, family]);
  const services = (catalog.data?.services ?? []).filter((s) => s.family_id === family);
  useEffect(() => { if (services.length && !services.some((s) => s.id === service)) setService(services[0].id); }, [family, catalog.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (catalog.error) return <LoadError message={catalog.error} onRetry={catalog.reload} />;
  if (catalog.loading && !catalog.data) return <Skeleton height={420} radius={16} />;
  const families = catalog.data!.families;
  const current = catalog.data!.services.find((s) => s.id === service) ?? null;

  return (
    <div className="tplm">
      <nav className="tplm__col tplm__families" aria-label="Famílias">
        <span className="label">Famílias</span>
        {mobile ? (
          <Select aria-label="Família" value={family ?? ""} onChange={(e) => setFamily(e.target.value)}>
            {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        ) : families.map((f) => (
          <FamilyButton key={f.id} f={f} active={f.id === family} count={catalog.data!.services.filter((s) => s.family_id === f.id).length}
            onClick={() => setFamily(f.id)} />
        ))}
      </nav>
      <section className="tplm__col tplm__services" aria-label="Serviços">
        <span className="label">Serviços</span>
        <ul className="svc-pick">
          {services.map((s) => (
            <li key={s.id}>
              <button type="button" className={cx("svc-pick__item", s.id === service && "is-active")} aria-current={s.id === service || undefined}
                onClick={() => setService(s.id)}>
                <span className="svc-pick__name">{s.name}</span>
                <span className="svc-pick__meta">
                  {s.available_for_b2c && <Badge tag outline>B2C</Badge>}
                  {s.available_for_b2b && <Badge tag outline>B2B</Badge>}
                  {!s.has_schedule_template && <span className="muted">Sem cronograma padrão</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="tplm__col tplm__detail" aria-label="Template selecionado">
        {current ? <ServicePanel key={current.id} service={current} canEdit={canEdit} onCatalogChanged={catalog.reload} />
          : <EmptyState icon="layers" title="Selecione um serviço." />}
      </section>
    </div>
  );
}

function FamilyButton({ f, active, count, onClick }: { f: ServiceFamily; active: boolean; count: number; onClick: () => void }) {
  return (
    <button type="button" className={cx("fam", active && "is-active")} aria-current={active || undefined} onClick={onClick}>
      <span className="grow truncate">{f.name}</span><span className="num muted">{count}</span>
    </button>
  );
}

function ServicePanel({ service, canEdit, onCatalogChanged }: { service: CatalogService; canEdit: boolean; onCatalogChanged: () => void }) {
  const toast = useToast();
  const templates = useAsync(() => api.listTemplates(service.id), [service.id]);
  const [variant, setVariant] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduleTemplate | null>(null);
  const [newVariant, setNewVariant] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = templates.data ?? [];
  const variants = useMemo(() => {
    const m = new Map<string, ScheduleTemplate[]>();
    list.forEach((t) => m.set(variantKey(t), [...(m.get(variantKey(t)) ?? []), t]));
    return [...m.entries()].map(([key, ts]) => ({ key, label: variantLabel(ts[0]), templates: ts.sort((a, b) => b.version - a.version) }));
  }, [list]);
  useEffect(() => { if (variants.length && !variants.some((v) => v.key === variant)) setVariant(variants[0].key); }, [variants, variant]);
  const cur = variants.find((v) => v.key === variant);
  const active = cur?.templates.find((t) => t.active) ?? null;
  const draft = cur?.templates.find((t) => t.status === "draft") ?? null;
  const shown = active ?? draft;

  async function toggle(field: "available_for_b2c" | "available_for_b2b" | "requires_area_rule") {
    const next = { [field]: !service[field] } as Partial<CatalogService>;
    if (field !== "requires_area_rule" && !next.available_for_b2c && !service.available_for_b2b && field === "available_for_b2c") {
      toast("O serviço precisa estar disponível para B2C ou B2B.", "error"); return;
    }
    if (field === "available_for_b2b" && !next.available_for_b2b && !service.available_for_b2c) {
      toast("O serviço precisa estar disponível para B2C ou B2B.", "error"); return;
    }
    try { await api.updateService(service.id, next); toast("Serviço atualizado."); onCatalogChanged(); }
    catch (e) { toast((e as Error).message, "error"); }
  }

  async function startDraft(from: ScheduleTemplate | null) {
    setBusy(true);
    try {
      const id = await api.createTemplateDraft(from ? { from: from.id } : { service_id: service.id, name: service.name });
      await templates.reload();
      const fresh = (await api.listTemplates(service.id)).find((t) => t.id === id) ?? null;
      setEditing(fresh);
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div>
          <h2 className="tplm__title">{service.name}</h2>
          <p className="subtext">{service.aliases.length ? `Também chega do CRM como: ${service.aliases.join(", ")}` : "Sem apelidos cadastrados para o CRM."}</p>
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <ToggleChip on={service.available_for_b2c} label="Disponível B2C" disabled={!canEdit} onClick={() => toggle("available_for_b2c")} />
        <ToggleChip on={service.available_for_b2b} label="Disponível B2B" disabled={!canEdit} onClick={() => toggle("available_for_b2b")} />
        <ToggleChip on={service.requires_area_rule} label="Prazo varia com a área" disabled={!canEdit} onClick={() => toggle("requires_area_rule")} />
      </div>

      {templates.error ? <LoadError message={templates.error} onRetry={templates.reload} /> :
       templates.loading && !templates.data ? <Skeleton height={260} radius={16} /> :
       variants.length === 0 ? (
        <Card>
          <EmptyState icon="layers" title="Sem cronograma padrão"
            text="A YouCon ainda não definiu os prazos deste serviço. Projetos com ele mostram “Sem cronograma padrão” e podem receber etapas manualmente."
            action={canEdit ? <Button size="sm" loading={busy} onClick={() => startDraft(null)}>Criar cronograma padrão</Button> : undefined} />
        </Card>
      ) : (
        <>
          {variants.length > 1 && (
            <Segmented<string> label="Variante" value={variant} onChange={setVariant}
              options={variants.map((v) => ({ value: v.key, label: v.label }))} />
          )}
          {shown && (
            <Card title={<>{shown.name} <span className="muted">· v{shown.version}</span></>}
              action={
                <div className="row">
                  {shown.status === "published" && <Badge tone="success" dot>Vigente</Badge>}
                  {draft && <Badge tone="warning" dot>Rascunho v{draft.version}</Badge>}
                </div>
              }>
              <p className="subtext tpl-meta">
                {variants.length === 1 && `${variantLabel(shown)} · `}
                {shown.published_at ? `Publicada em ${formatDate(shown.published_at, true)}` : "Ainda não publicada"}
                {shown.notes ? ` · ${shown.notes}` : ""}
              </p>
              <TemplateTaskList template={shown} />
              {canEdit && (
                <div className="row tpl-actions">
                  {draft ? (
                    <Button size="sm" icon="edit" onClick={() => setEditing(draft)}>Continuar rascunho v{draft.version}</Button>
                  ) : (
                    <Button size="sm" icon="edit" loading={busy} onClick={() => startDraft(active)}>Alterar padrão YouCon</Button>
                  )}
                  <Button size="sm" variant="ghost" icon="plus" onClick={() => setNewVariant(true)}>Nova variante</Button>
                </div>
              )}
            </Card>
          )}
          {cur && cur.templates.filter((t) => t.status === "archived").length > 0 && (
            <Card title="Versões anteriores">
              <ul className="history">
                {cur.templates.filter((t) => t.status === "archived").map((t) => (
                  <li key={t.id}><span className="history__what">v{t.version} · {t.tasks.length} etapas</span>
                    <span className="history__when num">{formatDate(t.published_at, true)}</span>
                    {t.notes && <span className="history__note">{t.notes}</span>}</li>
                ))}
              </ul>
              <p className="subtext card__note">Projetos que começaram com uma versão anterior continuam com ela.</p>
            </Card>
          )}
        </>
      )}

      {editing && (
        <TemplateEditor template={editing} service={service} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); void templates.reload(); onCatalogChanged(); }} />
      )}
      {newVariant && (
        <NewVariantDialog service={service} onClose={() => setNewVariant(false)}
          onCreated={async (id) => { setNewVariant(false); await templates.reload(); setEditing((await api.listTemplates(service.id)).find((t) => t.id === id) ?? null); }} />
      )}
    </div>
  );
}

function ToggleChip({ on, label, disabled, onClick }: { on: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="chip" aria-pressed={on} disabled={disabled} onClick={onClick} title={disabled ? "Somente o ADM Global altera" : undefined}>
      {on && <Icon name="check" size={14} />} {label}
    </button>
  );
}

function TemplateTaskList({ template }: { template: ScheduleTemplate }) {
  const deps = useAsync(() => api.templateDependencies(template.id), [template.id]);
  const cross = (taskId: string) => (deps.data ?? []).filter((d) => d.template_task_id === taskId && d.predecessor_service_code);
  const tasks = template.tasks.filter((t) => t.active);
  const fixedTotal = tasks.reduce((n, t) => n + (t.duration_type === "fixed" ? t.default_duration_days ?? 0 : 0), 0);
  const undefinedCount = tasks.filter((t) => t.duration_type === "fixed" && !t.default_duration_days).length;
  return (
    <>
      <ol className="tpl-steps">
        {tasks.map((t, i) => (
          <li key={t.id}>
            <span className="tpl-steps__n num">{i + 1}</span>
            <span className="grow">
              <span className="tpl-steps__name">{t.name}</span>
              <span className="tpl-steps__meta">
                {t.include_if_service_codes?.length ? `Só se contratado: ${t.include_if_service_codes.join(", ").replaceAll("_", " ")} · ` : ""}
                {cross(t.id).map((d) => `Aguarda ${d.predecessor_task_code?.replaceAll("_", " ")} (${d.predecessor_service_code?.replaceAll("_", " ")})`).join(" · ")}
                {!t.client_visible ? " · interna" : ""}
              </span>
            </span>
            <span className={cx("tpl-steps__dur", t.duration_type === "fixed" && !t.default_duration_days && "text-warning")}>
              {t.duration_type === "fixed" ? (t.default_duration_days ? `${t.default_duration_days} d.u.` : "A definir") : DURATION_TYPE_LABEL[t.duration_type]}
            </span>
          </li>
        ))}
      </ol>
      <p className="subtext card__note">
        {plural(tasks.length, "etapa", "etapas")} · {fixedTotal} dias úteis de prazos fixos
        {undefinedCount ? ` · ${plural(undefinedCount, "etapa", "etapas")} com prazo a definir` : ""}
      </p>
    </>
  );
}

/* ---------- Editor de rascunho ---------- */
interface DraftRow {
  key: string; id: string | null; name: string; duration_type: DurationType; duration: string; client_visible: boolean;
  include_if: string[] | null; cross: string; // "service_code.task_code" ou ""
}

function TemplateEditor({ template, service, onClose, onDone }: {
  template: ScheduleTemplate; service: CatalogService; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const listId = useId();
  const library = useAsync(() => api.listTaskLibrary(), []);
  const crossOptions = useAsync(() => api.activeTemplateTasks(), []);
  const deps = useAsync(() => api.templateDependencies(template.id), [template.id]);
  const [name, setName] = useState(template.name);
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"save" | "publish" | "discard" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"publish" | "discard" | null>(null);

  useEffect(() => {
    if (!deps.data || rows) return;
    const crossOf = (id: string) => {
      const d = deps.data!.find((x: TemplateDependency) => x.template_task_id === id && x.predecessor_service_code);
      return d ? `${d.predecessor_service_code}.${d.predecessor_task_code}` : "";
    };
    setRows(template.tasks.filter((t) => t.active).map((t: TemplateTask) => ({
      key: t.id, id: t.id, name: t.name, duration_type: t.duration_type, duration: t.default_duration_days ? String(t.default_duration_days) : "",
      client_visible: t.client_visible, include_if: t.include_if_service_codes, cross: crossOf(t.id),
    })));
  }, [deps.data, rows, template.tasks]);

  const update = (key: string, patch: Partial<DraftRow>) => setRows((rs) => rs!.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => setRows((rs) => {
    const next = [...rs!]; const j = i + d; if (j < 0 || j >= next.length) return next;
    [next[i], next[j]] = [next[j], next[i]]; return next;
  });
  const add = () => setRows((rs) => [...rs!, { key: crypto.randomUUID(), id: null, name: "", duration_type: "fixed", duration: "", client_visible: true, include_if: null, cross: "" }]);
  const fromLibrary = (key: string, value: string) => {
    const l = (library.data ?? []).find((x: TaskLibraryItem) => x.name.toLowerCase() === value.trim().toLowerCase());
    update(key, l ? { name: value, ...(l.default_duration_days ? { duration: String(l.default_duration_days) } : {}),
      ...(l.duration_type !== "dependent" ? { duration_type: l.duration_type } : {}) } : { name: value });
  };

  const payload = () => rows!.map((r) => ({
    id: r.id, name: r.name.trim(), duration_type: r.duration_type,
    duration_days: r.duration_type === "fixed" && r.duration ? Number(r.duration) : null,
    client_visible: r.client_visible, include_if: r.include_if,
    cross_deps: r.cross ? [{ service_code: r.cross.split(".")[0], task_code: r.cross.split(".")[1] }] : [],
  }));

  async function save(thenPublish: boolean) {
    setBusy(thenPublish ? "publish" : "save"); setErr(null);
    try {
      await api.saveTemplateDraft(template.id, name, payload());
      if (thenPublish) {
        await api.publishTemplate(template.id, notes);
        toast(`Versão ${template.version} publicada. Novos projetos já usam este padrão.`);
        onDone();
      } else {
        toast("Rascunho salvo.");
      }
    } catch (e) { setErr((e as Error).message); setConfirm(null); } finally { setBusy(null); }
  }

  const otherServices = (crossOptions.data ?? []).filter((o) => o.service_code !== service.code);
  const grouped = otherServices.reduce<Record<string, typeof otherServices>>((acc, o) => { (acc[o.service_name] ??= []).push(o); return acc; }, {});

  return (
    <Drawer open onClose={onClose} title={`Alterar padrão YouCon · v${template.version}`}
      subtitle={`${service.name} · ${variantLabel(template)} · rascunho`}
      footer={
        <>
          <Button variant="danger-ghost" loading={busy === "discard"} onClick={() => setConfirm("discard")}>Descartar</Button>
          <span className="spacer" />
          <Button variant="secondary" loading={busy === "save"} disabled={!rows} onClick={() => save(false)}>Salvar rascunho</Button>
          <Button loading={busy === "publish"} disabled={!rows} onClick={() => setConfirm("publish")}>Publicar versão</Button>
        </>
      }>
      <div className="form">
        <Alert tone="info" title="Alterar padrão YouCon">Vale para novos projetos. Projetos em andamento continuam com a versão que usaram. Para mudar um projeto só, use “Ajustar prazo” ou “Adicionar etapa” no cronograma dele.</Alert>
        {err && <Alert tone="danger" title="Não foi salvo">{err}</Alert>}
        <Field label="Nome do template">{({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <datalist id={listId}>{(library.data ?? []).map((l) => <option key={l.id} value={l.name} />)}</datalist>

        {!rows ? <Skeleton height={240} /> : (
          <fieldset className="form__group">
            <legend className="label">Etapas, em ordem</legend>
            <p className="subtext">Cada etapa começa quando a anterior termina. Prazos em dias úteis; em branco = a definir.</p>
            <ol className="tpl-edit">
              {rows.map((r, i) => (
                <li key={r.key} className="tpl-edit__row">
                  <div className="tpl-edit__order">
                    <Button variant="ghost" size="sm" iconOnly icon="chevronDown" className="flip" disabled={i === 0} onClick={() => move(i, -1)}>Subir</Button>
                    <span className="num muted">{i + 1}</span>
                    <Button variant="ghost" size="sm" iconOnly icon="chevronDown" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>Descer</Button>
                  </div>
                  <div className="tpl-edit__fields">
                    <Input aria-label={`Nome da etapa ${i + 1}`} list={listId} value={r.name} placeholder="Nome (escolha da biblioteca ou digite)"
                      onChange={(e) => fromLibrary(r.key, e.target.value)} />
                    <div className="tpl-edit__line">
                      <Select aria-label="Tipo de prazo" value={r.duration_type} onChange={(e) => update(r.key, { duration_type: e.target.value as DurationType })}>
                        {(Object.keys(DURATION_TYPE_LABEL) as DurationType[]).map((k) => <option key={k} value={k}>{DURATION_TYPE_LABEL[k]}</option>)}
                      </Select>
                      {r.duration_type === "fixed" && (
                        <Input aria-label="Dias úteis" type="number" min={1} max={2000} inputMode="numeric" placeholder="Dias úteis"
                          value={r.duration} onChange={(e) => update(r.key, { duration: e.target.value })} />
                      )}
                      <label className="check"><input type="checkbox" checked={r.client_visible} onChange={(e) => update(r.key, { client_visible: e.target.checked })} /> Cliente vê</label>
                    </div>
                    <Select aria-label="Aguarda etapa de outro serviço" value={r.cross} onChange={(e) => update(r.key, { cross: e.target.value })}>
                      <option value="">{r.duration_type === "dependent" ? "Escolha a etapa de outro serviço (obrigatório)" : "Não aguarda outro serviço"}</option>
                      {Object.entries(grouped).map(([svc, opts]) => (
                        <optgroup key={svc} label={svc}>{opts.map((o) => <option key={`${o.service_code}.${o.code}`} value={`${o.service_code}.${o.code}`}>Aguarda: {o.name}</option>)}</optgroup>
                      ))}
                    </Select>
                    {r.include_if?.length ? <span className="subtext">Só entra se contratado: {r.include_if.join(", ").replaceAll("_", " ")}</span> : null}
                  </div>
                  <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => setRows((rs) => rs!.filter((x) => x.key !== r.key))}>Remover etapa</Button>
                </li>
              ))}
            </ol>
            <div><Button variant="outline" size="sm" icon="plus" onClick={add}>Adicionar etapa</Button></div>
          </fieldset>
        )}
        <Field label="Nota da versão" hint="Opcional. Aparece no histórico de versões.">
          {({ id }) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: inclui levantamento no local" />}
        </Field>
      </div>

      <ConfirmDialog open={confirm === "publish"} title={`Publicar versão ${template.version}?`}
        message="Novos projetos passam a usar este padrão. Projetos já iniciados não mudam." confirmLabel="Publicar"
        loading={busy === "publish"} onCancel={() => setConfirm(null)} onConfirm={() => save(true)} />
      <ConfirmDialog open={confirm === "discard"} title="Descartar rascunho?" danger
        message="As alterações deste rascunho serão perdidas. A versão vigente continua valendo." confirmLabel="Descartar"
        loading={busy === "discard"} onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setBusy("discard");
          try { await api.discardTemplateDraft(template.id); toast("Rascunho descartado."); onDone(); }
          catch (e) { setErr((e as Error).message); setConfirm(null); } finally { setBusy(null); }
        }} />
    </Drawer>
  );
}

function NewVariantDialog({ service, onClose, onCreated }: { service: CatalogService; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [ct, setCt] = useState<"all" | ClientType>("all");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Drawer open onClose={onClose} title="Nova variante" subtitle={service.name}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} onClick={async () => {
          setBusy(true);
          try {
            const id = await api.createTemplateDraft({ service_id: service.id, client_type: ct === "all" ? null : ct,
              area_min: min ? Number(min) : null, area_max: max ? Number(max) : null, name: service.name });
            onCreated(id);
          } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
        }}>Criar rascunho</Button></>}>
      <div className="form">
        <p className="subtext">Use variantes quando os prazos mudam conforme o tipo de cliente ou a área (ex.: Interiores até 500 m² e acima de 500 m²). Faixas de área não podem se sobrepor.</p>
        <Segmented<"all" | ClientType> label="Tipo de cliente" value={ct} onChange={setCt}
          options={[{ value: "all", label: "B2C e B2B" }, { value: "b2c", label: "Só B2C" }, { value: "b2b", label: "Só B2B" }]} />
        <div className="form__cols">
          <Field label="Área acima de (m²)" hint="Em branco = sem mínimo">{({ id }) => <Input id={id} type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />}</Field>
          <Field label="Área até (m²)" hint="Em branco = sem máximo">{({ id }) => <Input id={id} type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
        </div>
      </div>
    </Drawer>
  );
}

/* ==========================================================================
   Biblioteca de etapas
   ========================================================================== */
function LibraryManager() {
  const { permissions } = useAuth();
  const toast = useToast();
  const canAdd = !!permissions?.is_manager;
  const isGlobal = permissions?.role === "global_admin";
  const lib = useAsync(() => api.listTaskLibrary(true), []);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<TaskLibraryItem | "new" | null>(null);

  const list = (lib.data ?? []).filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()));
  const canEditItem = (l: TaskLibraryItem) => isGlobal || (canAdd && l.created_by === permissions?.profile_id);

  return (
    <div className="stack">
      <div className="row-between">
        <SearchInput placeholder="Buscar etapa" aria-label="Buscar etapa" value={q} onChange={(e) => setQ(e.target.value)} />
        {canAdd && <Button icon="plus" onClick={() => setEditing("new")}>Registrar etapa</Button>}
      </div>
      <p className="subtext">Etapas registradas aqui aparecem como opção ao montar os padrões YouCon e ao incluir uma etapa extra num projeto.</p>
      {lib.error ? <LoadError message={lib.error} onRetry={lib.reload} /> : lib.loading && !lib.data ? <Skeleton height={300} radius={16} /> :
        list.length === 0 ? <Card><EmptyState icon="search" title={q ? "Nenhuma etapa encontrada." : "Nenhuma etapa registrada."} /></Card> : (
          <Card flush>
            <ul className="tasklist">
              {list.map((l) => (
                <li key={l.id}>
                  <div className={cx("task", !l.active && "is-muted")}>
                    <span className="task__main">
                      <span className="task__name">{l.name}</span>
                      {l.description && <span className="task__meta truncate">{l.description}</span>}
                    </span>
                    <span className="task__side">
                      {!l.active && <Badge>Inativa</Badge>}
                      <span className="muted">{l.duration_type === "fixed" ? (l.default_duration_days ? `${l.default_duration_days} d.u.` : "Prazo a definir") : DURATION_TYPE_LABEL[l.duration_type]}</span>
                      {canEditItem(l) && <Button variant="ghost" size="sm" iconOnly icon="edit" onClick={() => setEditing(l)}>Editar</Button>}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      {editing && (
        <LibraryDrawer item={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); toast("Biblioteca atualizada."); void lib.reload(); }} />
      )}
    </div>
  );
}

function LibraryDrawer({ item, onClose, onSaved }: { item: TaskLibraryItem | null; onClose: () => void; onSaved: () => void }) {
  const { permissions } = useAuth();
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [kind, setKind] = useState<"fixed" | "external" | "ongoing">(item?.duration_type === "external" || item?.duration_type === "ongoing" ? item.duration_type : "fixed");
  const [days, setDays] = useState(item?.default_duration_days ? String(item.default_duration_days) : "");
  const [active, setActive] = useState(item?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Drawer open onClose={onClose} title={item ? "Editar etapa" : "Registrar etapa"} subtitle="Biblioteca de etapas"
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} disabled={name.trim().length < 2} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            await api.saveTaskLibraryItem({ id: item?.id, name, description, duration_type: kind, default_duration_days: days ? Number(days) : null,
              active: item ? active : undefined, created_by: permissions?.profile_id ?? null });
            onSaved();
          } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Salvar</Button></>}>
      <div className="form">
        {err && <Alert tone="danger">{err}</Alert>}
        <Field label="Nome" required>{({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Vídeo 3D" />}</Field>
        <Field label="Descrição" hint="Opcional.">{({ id }) => <textarea id={id} className="input textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Segmented<"fixed" | "external" | "ongoing"> label="Tipo de prazo" value={kind} onChange={setKind}
          options={[{ value: "fixed", label: "Dias úteis" }, { value: "external", label: "Terceiros" }, { value: "ongoing", label: "Contínua" }]} />
        {kind === "fixed" && (
          <Field label="Prazo sugerido (dias úteis)" hint="Opcional. Em branco = a definir em cada uso.">
            {({ id }) => <Input id={id} type="number" min={1} max={2000} value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        )}
        {item && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Disponível para seleção</label>}
      </div>
    </Drawer>
  );
}
