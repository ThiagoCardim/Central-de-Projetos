import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, LoadError, SearchInput, Segmented, Select, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, Modal, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type {
  CatalogService, ClientType, DurationType, ScheduleTemplate, ServiceFamily, TaskLibraryItem, TemplateDependency,
} from "@/types/domain";
import { cx, formatDate, plural } from "@/utils/format";
import { StepPicker } from "@/components/ui/StepPicker";
import { DURATION_TYPE_LABEL } from "@/pages/schedule/model";
import { groupIndexes, parallelFromDeps, useDragSort } from "@/components/ui/sortable";

type Tab = "templates" | "library";

export function TemplatesPage() {
  useDocumentTitle("Serviços e Cronogramas");
  const { permissions } = useAuth();
  const canEdit = !!permissions?.can_manage_templates;
  const [tab, setTab] = useState<Tab>("templates");
  return (
    <div className="page">
      <PageHead title="Serviços e Cronogramas"
        subtitle="Os padrões YouCon definem as etapas, a ordem e os prazos que cada serviço recebe quando um projeto começa." />
      <Tabs<Tab> label="Seções" value={tab} onChange={setTab} tabs={[
        { value: "templates", label: "Padrões por serviço" },
        { value: "library", label: "Biblioteca de etapas" },
      ]} />
      {tab === "templates" ? <TemplatesManager canEdit={canEdit} /> : <LibraryManager />}
    </div>
  );
}

/* ==========================================================================
   Utilidades de variante e fases
   ========================================================================== */
type Variant = Pick<ScheduleTemplate, "client_type" | "area_min" | "area_max">;
const variantKey = (t: Variant) => `${t.client_type ?? "all"}|${t.area_min ?? ""}|${t.area_max ?? ""}`;
function variantLabel(t: Variant, short = false) {
  const parts: string[] = [];
  if (t.client_type) parts.push(`Só ${t.client_type.toUpperCase()}`);
  else if (!short) parts.push("B2C e B2B");
  if (t.area_min != null && t.area_max != null) parts.push(`${t.area_min}–${t.area_max} m²`);
  else if (t.area_max != null) parts.push(`até ${t.area_max} m²`);
  else if (t.area_min != null) parts.push(`acima de ${t.area_min} m²`);
  return parts.join(" · ") || "Padrão geral";
}

interface FlowStep { id: string; name: string; duration_type: DurationType; days: number | null; client_visible: boolean;
  include_if: string[] | null; waits: string[] }

/** Agrupa etapas ativas em fases a partir das dependências internas do padrão. */
function toPhases(template: ScheduleTemplate, deps: TemplateDependency[]): FlowStep[][] {
  const tasks = template.tasks.filter((t) => t.active);
  const internal = (id: string) => deps.filter((d) => d.template_task_id === id && d.predecessor_task_id).map((d) => d.predecessor_task_id!);
  const groups = groupIndexes(parallelFromDeps(tasks.map((t) => t.id), internal));
  const phases: FlowStep[][] = [];
  tasks.forEach((t, i) => {
    (phases[groups[i]] ??= []).push({
      id: t.id, name: t.name, duration_type: t.duration_type, days: t.default_duration_days, client_visible: t.client_visible,
      include_if: t.include_if_service_codes,
      waits: deps.filter((d) => d.template_task_id === t.id && d.predecessor_service_code)
        .map((d) => `${(d.predecessor_task_code ?? "").replaceAll("_", " ")} (${(d.predecessor_service_code ?? "").replaceAll("_", " ")})`),
    });
  });
  return phases;
}

function phaseDuration(steps: { duration_type: DurationType; days: number | null }[]) {
  const fixed = steps.filter((s) => s.duration_type === "fixed");
  const partial = fixed.some((s) => !s.days) || steps.some((s) => s.duration_type === "dependent" || s.duration_type === "external");
  const max = Math.max(0, ...fixed.map((s) => s.days ?? 0));
  return { days: max, partial };
}

function durationLabel(s: { duration_type: DurationType; days: number | null }) {
  if (s.duration_type === "fixed") return s.days ? `${s.days} d.u.` : "A definir";
  if (s.duration_type === "dependent") return "Conforme outro serviço";
  if (s.duration_type === "external") return "Prazo de terceiros";
  return "Contínua";
}

/* ==========================================================================
   Padrões por serviço
   ========================================================================== */
function TemplatesManager({ canEdit }: { canEdit: boolean }) {
  const mobile = useIsMobile();
  const catalog = useAsync(() => api.listCatalog(), []);
  const summaries = useAsync(() => api.templateSummaries(), []);
  const [service, setService] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => { if (!service && catalog.data?.services.length) setService(catalog.data.services[0].id); }, [catalog.data, service]);
  const reloadAll = () => { void catalog.reload(); void summaries.reload(); };

  if (catalog.error) return <LoadError message={catalog.error} onRetry={catalog.reload} />;
  if (catalog.loading && !catalog.data) return <Skeleton height={420} radius={16} />;
  const { families, services } = catalog.data!;
  const current = services.find((s) => s.id === service) ?? null;
  const statusOf = (s: CatalogService) => {
    const mine = (summaries.data ?? []).filter((t) => t.service_id === s.id);
    if (mine.some((t) => t.status === "draft")) return { tone: "warning" as const, text: "Rascunho em edição" };
    const active = mine.filter((t) => t.active);
    if (active.length) return { tone: "success" as const, text: active.length > 1 ? `${active.length} variantes` : `Padrão v${active[0].version}` };
    return { tone: "neutral" as const, text: "Sem cronograma padrão" };
  };

  return (
    <div className="svcm">
      <nav className="svcm__nav" aria-label="Serviços">
        {mobile ? (
          <Select aria-label="Serviço" value={service ?? ""} onChange={(e) => setService(e.target.value)}>
            {families.map((f) => (
              <optgroup key={f.id} label={f.name}>
                {services.filter((s) => s.family_id === f.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            ))}
          </Select>
        ) : (
          <>
            <SearchInput placeholder="Buscar serviço" aria-label="Buscar serviço" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="svcm__groups">
              {families.map((f: ServiceFamily) => {
                const list = services.filter((s) => s.family_id === f.id && (!q || s.name.toLowerCase().includes(q.toLowerCase())));
                if (!list.length) return null;
                return (
                  <div key={f.id} className="svcm__group">
                    <span className="label">{f.name}</span>
                    {list.map((s) => {
                      const st = statusOf(s);
                      return (
                        <button key={s.id} type="button" className={cx("svcm__item", s.id === service && "is-active")}
                          aria-current={s.id === service || undefined} onClick={() => setService(s.id)}>
                          <span className="svcm__name">{s.name}</span>
                          <span className={cx("svcm__status", `tone-${st.tone}`)}><span className="svcm__dot" aria-hidden="true" />{st.text}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </nav>
      <section className="svcm__main" aria-label="Padrão do serviço">
        {current ? (
          <ServiceWorkspace key={current.id} service={current} family={families.find((f) => f.id === current.family_id)?.name ?? ""}
            canEdit={canEdit} onChanged={reloadAll} />
        ) : <EmptyState icon="layers" title="Selecione um serviço." />}
      </section>
    </div>
  );
}

function ServiceWorkspace({ service, family, canEdit, onChanged }: { service: CatalogService; family: string; canEdit: boolean; onChanged: () => void }) {
  const toast = useToast();
  const templates = useAsync(() => api.listTemplates(service.id), [service.id]);
  const usage = useAsync(() => api.templateUsage(service.id), [service.id]);
  const [variant, setVariant] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduleTemplate | null>(null);
  const [panel, setPanel] = useState<"settings" | "variant" | "delete" | "discard" | null>(null);
  const [busy, setBusy] = useState(false);

  const list = templates.data ?? [];
  const variants = useMemo(() => {
    const m = new Map<string, ScheduleTemplate[]>();
    list.forEach((t) => m.set(variantKey(t), [...(m.get(variantKey(t)) ?? []), t]));
    return [...m.entries()].map(([key, ts]) => ({ key, base: ts[0], templates: ts.sort((a, b) => b.version - a.version) }))
      .filter((v) => v.templates.some((t) => t.active || t.status === "draft"));
  }, [list]);
  useEffect(() => { if (variants.length && !variants.some((v) => v.key === variant)) setVariant(variants[0].key); }, [variants, variant]);
  const cur = variants.find((v) => v.key === variant) ?? null;
  const active = cur?.templates.find((t) => t.active) ?? null;
  const draft = cur?.templates.find((t) => t.status === "draft") ?? null;
  const history = list.filter((t) => t.status !== "draft").sort((a, b) => b.version - a.version);
  const inUse = (ids: string[]) => (usage.data ?? []).filter((u) => ids.includes(u.template_id)).reduce((n, u) => n + u.projects_in_progress, 0);
  const reload = () => { void templates.reload(); void usage.reload(); onChanged(); };

  async function openDraft(from: ScheduleTemplate | null) {
    setBusy(true);
    try {
      const id = await api.createTemplateDraft(from ? { from: from.id } : { service_id: service.id, name: service.name });
      const fresh = (await api.listTemplates(service.id)).find((t) => t.id === id) ?? null;
      void templates.reload(); onChanged();
      setEditing(fresh);
    } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
  }

  const facts = [
    service.available_for_b2c && service.available_for_b2b ? "Atende B2C e B2B" : service.available_for_b2c ? "Só B2C" : "Só B2B",
    service.requires_area_rule ? "Prazos variam com a área" : "Prazo único para qualquer área",
  ];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <header className="svcw__head">
        <div className="grow">
          <span className="label">{family}</span>
          <h2 className="svcw__title">{service.name}</h2>
          <p className="subtext">{facts.join(" · ")}{service.aliases.length ? ` · No CRM também: ${service.aliases.join(", ")}` : ""}</p>
        </div>
        {canEdit && (
          <div className="row">
            {draft ? <Button icon="edit" onClick={() => setEditing(draft)}>Continuar edição</Button>
              : active ? <Button icon="edit" loading={busy} onClick={() => openDraft(active)}>Editar padrão</Button>
              : <Button icon="plus" loading={busy} onClick={() => openDraft(null)}>Criar padrão</Button>}
            <MoreMenu items={[
              { label: "Configurações do serviço", icon: "edit", onClick: () => setPanel("settings") },
              { label: "Nova variante (por área ou cliente)", icon: "plus", onClick: () => setPanel("variant") },
              ...(cur ? [{ label: "Excluir padrão", icon: "x" as const, danger: true, onClick: () => setPanel("delete") }] : []),
            ]} />
          </div>
        )}
      </header>

      {templates.error ? <LoadError message={templates.error} onRetry={templates.reload} /> :
       templates.loading && !templates.data ? <Skeleton height={260} radius={16} /> :
       variants.length === 0 ? (
        <Card>
          <EmptyState icon="layers" title="Sem cronograma padrão"
            text="Projetos com este serviço mostram “Sem cronograma padrão” e podem receber etapas manualmente. Crie o padrão quando a YouCon definir as etapas e prazos."
            action={canEdit ? <Button size="sm" icon="plus" loading={busy} onClick={() => openDraft(null)}>Criar padrão</Button> : undefined} />
        </Card>
      ) : (
        <>
          {variants.length > 1 && (
            <Tabs<string> label="Variantes do padrão" value={variant ?? variants[0].key} onChange={setVariant}
              tabs={variants.map((v) => ({ value: v.key, label: variantLabel(v.base, true) }))} />
          )}
          {draft && (
            <Alert tone="warning" title={`Rascunho v${draft.version} ainda não publicado`}
              action={canEdit ? (
                <div className="row">
                  <Button size="sm" onClick={() => setEditing(draft)}>Continuar edição</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPanel("discard")}>Descartar</Button>
                </div>) : undefined}>
              {active ? `Novos projetos continuam usando a versão ${active.version} até a publicação.` : "Este serviço ainda não tem padrão publicado."}
            </Alert>
          )}
          {(active ?? draft) && <FlowCard template={(active ?? draft)!} usage={active ? inUse([active.id]) : 0} variants={variants.length} />}
        </>
      )}
      {history.length > 0 && (
        <details className="versions">
          <summary><Icon name="clock" size={16} /> Histórico de versões <span className="muted">· {history.length}</span></summary>
          <ul className="history">
            {history.map((t) => (
              <li key={t.id}>
                <span className="history__what">
                  v{t.version} · {variantLabel(t)} {t.active ? <Badge tone="success">Vigente</Badge> : <Badge>Arquivada</Badge>}
                </span>
                <span className="history__when num">{formatDate(t.published_at, true)}</span>
                <span className="history__note">{plural(t.tasks.length, "etapa", "etapas")}{t.notes ? ` · ${t.notes}` : ""}{inUse([t.id]) ? ` · ${plural(inUse([t.id]), "projeto em andamento", "projetos em andamento")}` : ""}</span>
                {canEdit && !t.active && !draft && (
                  <span className="history__note"><Button size="sm" variant="ghost" icon="refresh" loading={busy} onClick={() => openDraft(t)}>Usar como base de nova versão</Button></span>
                )}
              </li>
            ))}
          </ul>
          <p className="subtext card__note">Projetos usam a versão que estava vigente quando começaram; alterações futuras não mudam projetos em andamento.</p>
        </details>
      )}

      {editing && <TemplateEditor template={editing} service={service} onClose={() => setEditing(null)} onSaved={reload} onDone={() => { setEditing(null); reload(); }} />}
      {panel === "settings" && <ServiceSettings service={service} onClose={() => setPanel(null)} onSaved={() => { setPanel(null); onChanged(); }} />}
      {panel === "variant" && (
        <NewVariantDrawer service={service} onClose={() => setPanel(null)}
          onCreated={async (id) => { setPanel(null); const fresh = (await api.listTemplates(service.id)).find((t) => t.id === id) ?? null; reload(); setEditing(fresh); }} />
      )}
      {panel === "delete" && cur && (
        <DeleteTemplateDialog service={service} variant={cur.base} variantsCount={variants.length}
          templateId={(active ?? draft ?? cur.templates[0]).id} projects={inUse(cur.templates.map((t) => t.id))}
          onClose={() => setPanel(null)} onDeleted={() => { setPanel(null); reload(); }} />
      )}
      <ConfirmDialog open={panel === "discard"} danger title={`Descartar rascunho v${draft?.version ?? ""}?`}
        message="As alterações deste rascunho serão perdidas. A versão vigente continua valendo." confirmLabel="Descartar rascunho"
        loading={busy} onCancel={() => setPanel(null)}
        onConfirm={async () => {
          if (!draft) return;
          setBusy(true);
          try { await api.discardTemplateDraft(draft.id); toast("Rascunho descartado."); setPanel(null); reload(); }
          catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
        }} />
    </div>
  );
}

/* ---------- Menu "mais ações" ---------- */
function MoreMenu({ items }: { items: { label: string; icon: "edit" | "plus" | "x"; danger?: boolean; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <Button variant="outline" iconOnly icon="more" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Mais ações</Button>
      {open && (
        <div className="menu__list" role="menu">
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={cx("menu__item", it.danger && "is-danger")}
              onClick={() => { setOpen(false); it.onClick(); }}>
              <Icon name={it.icon} size={16} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Fluxo visual por fases ---------- */
function FlowCard({ template, usage, variants }: { template: ScheduleTemplate; usage: number; variants: number }) {
  const deps = useAsync(() => api.templateDependencies(template.id), [template.id]);
  const phases = deps.data ? toPhases(template, deps.data) : null;
  const total = phases?.reduce((n, ph) => n + phaseDuration(ph).days, 0) ?? 0;
  const partial = phases?.some((ph) => phaseDuration(ph).partial) ?? false;
  const steps = phases?.reduce((n, ph) => n + ph.length, 0) ?? 0;

  return (
    <Card title={<>Fluxo do padrão <span className="muted">· v{template.version}{variants > 1 ? ` · ${variantLabel(template)}` : ""}</span></>}
      action={template.status === "draft" ? <Badge tone="warning" dot>Rascunho</Badge> : <Badge tone="success" dot>Vigente</Badge>}>
      <p className="subtext flow__meta">
        {template.published_at ? `Publicado em ${formatDate(template.published_at, true)}` : "Ainda não publicado"}
        {usage ? ` · ${plural(usage, "projeto em andamento usa", "projetos em andamento usam")} esta versão` : ""}
        {template.notes ? ` · ${template.notes}` : ""}
      </p>
      {!phases ? <Skeleton height={160} /> : (
        <>
          <ol className="flow" aria-label="Fases do padrão em ordem">
            {phases.map((ph, i) => {
              const d = phaseDuration(ph);
              return (
                <li key={i} className={cx("flow__phase", ph.length > 1 && "phase--parallel")}>
                  <span className="flow__rail" aria-hidden="true"><span className="flow__n">{i + 1}</span></span>
                  <div className="flow__body">
                    <div className="phase__head">
                      <span className="phase__n">Fase {i + 1}</span>
                      <span className="phase__dur num">{d.days ? `${d.days} dias úteis` : ""}{d.partial ? (d.days ? " + a definir" : "Prazo a definir") : ""}</span>
                      {ph.length > 1 && <span className="phase__par"><Icon name="parallel" size={14} /> {ph.length} etapas ao mesmo tempo</span>}
                    </div>
                    <ul className="phase__steps">
                      {ph.map((s) => (
                        <li key={s.id} className="pstep">
                          <span className="pstep__name">{s.name}</span>
                          <span className={cx("pstep__dur", s.duration_type === "fixed" && !s.days && "text-warning")}>{durationLabel(s)}</span>
                          {(s.waits.length > 0 || s.include_if?.length || !s.client_visible) && (
                            <span className="pstep__tags">
                              {s.waits.map((w) => <span key={w} className="pstep__tag">Aguarda {w}</span>)}
                              {s.include_if?.length ? <span className="pstep__tag">Só se contratar {s.include_if.join(", ").replaceAll("_", " ")}</span> : null}
                              {!s.client_visible && <span className="pstep__tag">Interna</span>}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="flow__legend">
            <span><Icon name="sequence" size={14} /> uma fase começa quando a anterior termina</span>
            <span><Icon name="parallel" size={14} /> etapas lado a lado acontecem ao mesmo tempo</span>
            <span className="grow" />
            <span className="num"><strong>{plural(steps, "etapa", "etapas")}</strong> em {plural(phases.length, "fase", "fases")} · ~{total} dias úteis{partial ? " + prazos a definir" : ""}</span>
          </div>
        </>
      )}
    </Card>
  );
}

/* ==========================================================================
   Editor por fases
   ========================================================================== */
interface EStep { key: string; id: string | null; name: string; duration_type: DurationType; days: string; client_visible: boolean;
  include_if: string[] | null; cross: string; showCross: boolean }
interface EPhase { key: string; steps: EStep[] }
const newStep = (): EStep => ({ key: crypto.randomUUID(), id: null, name: "", duration_type: "fixed", days: "", client_visible: true, include_if: null, cross: "", showCross: false });

function TemplateEditor({ template, service, onClose, onSaved, onDone }: {
  template: ScheduleTemplate; service: CatalogService; onClose: () => void; onSaved: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const { permissions } = useAuth();
  const library = useAsync(() => api.listTaskLibrary(), []);
  const crossOptions = useAsync(() => api.activeTemplateTasks(), []);
  const deps = useAsync(() => api.templateDependencies(template.id), [template.id]);
  const [name, setName] = useState(template.name);
  const [phases, setPhases] = useState<EPhase[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [notes, setNotes] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [drag, setDrag] = useState<{ p: number; s: number } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!deps.data || phases) return;
    const flow = toPhases(template, deps.data);
    const crossOf = (id: string) => {
      const d = deps.data!.find((x) => x.template_task_id === id && x.predecessor_service_code);
      return d ? `${d.predecessor_service_code}.${d.predecessor_task_code}` : "";
    };
    setPhases(flow.length ? flow.map((ph) => ({ key: crypto.randomUUID(), steps: ph.map((s) => ({
      key: s.id, id: s.id, name: s.name, duration_type: s.duration_type, days: s.days ? String(s.days) : "",
      client_visible: s.client_visible, include_if: s.include_if, cross: crossOf(s.id), showCross: !!crossOf(s.id),
    })) })) : [{ key: crypto.randomUUID(), steps: [newStep()] }]);
  }, [deps.data, phases, template]);

  const mutate = (fn: (ps: EPhase[]) => EPhase[]) => { setPhases((ps) => fn(ps!.map((p) => ({ ...p, steps: [...p.steps] })))); setDirty(true); };
  const updateStep = (pi: number, si: number, patch: Partial<EStep>) => mutate((ps) => { ps[pi].steps[si] = { ...ps[pi].steps[si], ...patch }; return ps; });
  const fromLibrary = (pi: number, si: number, l: TaskLibraryItem) =>
    updateStep(pi, si, { name: l.name, ...(l.default_duration_days ? { days: String(l.default_duration_days) } : {}),
      ...(l.duration_type !== "dependent" ? { duration_type: l.duration_type } : {}) });
  const createInLibrary = async (input: { name: string; duration_type: "fixed" | "external" | "ongoing"; default_duration_days: number | null }) => {
    const item = await api.createTaskLibraryItem({ ...input, created_by: permissions?.profile_id ?? null });
    library.setData([...(library.data ?? []), item]);
    toast(`“${item.name}” registrada na biblioteca.`);
    return item;
  };
  const addPhaseAt = (index: number) => mutate((ps) => { ps.splice(index, 0, { key: crypto.randomUUID(), steps: [newStep()] }); return ps; });
  const movePhase = (i: number, d: -1 | 1) => mutate((ps) => { const j = i + d; if (j < 0 || j >= ps.length) return ps; [ps[i], ps[j]] = [ps[j], ps[i]]; return ps; });
  const removeStep = (pi: number, si: number) => mutate((ps) => { ps[pi].steps.splice(si, 1); return ps.filter((p) => p.steps.length > 0); });
  const dropOn = (pi: number, si: number | null) => {
    if (!drag) return;
    const from = drag;
    mutate((ps) => {
      const [moved] = ps[from.p].steps.splice(from.s, 1);
      let target = si ?? ps[pi].steps.length;
      if (from.p === pi && si !== null && from.s < si) target -= 1;
      ps[pi].steps.splice(Math.max(0, target), 0, moved);
      return ps.filter((p) => p.steps.length > 0);
    });
    setDrag(null); setOver(null);
  };

  const payload = () => phases!.flatMap((ph) => ph.steps.map((s, i) => ({
    id: s.id, name: s.name.trim(), duration_type: s.duration_type, parallel: i > 0,
    duration_days: s.duration_type === "fixed" && s.days ? Number(s.days) : null,
    client_visible: s.client_visible, include_if: s.include_if,
    cross_deps: s.cross ? [{ service_code: s.cross.split(".")[0], task_code: s.cross.split(".")[1] }] : [],
  })));

  async function save(thenPublish: boolean) {
    if (phases!.some((ph) => ph.steps.some((x) => !x.name.trim()))) {
      setMissing(true); setPublishing(false); setErr("Selecione a etapa em todas as linhas (ou remova as linhas vazias).");
      return;
    }
    setBusy(thenPublish ? "publish" : "save"); setErr(null);
    try {
      await api.saveTemplateDraft(template.id, name, payload());
      setDirty(false);
      if (thenPublish) {
        await api.publishTemplate(template.id, notes);
        toast(`Versão ${template.version} publicada. Novos projetos já usam este padrão.`);
        onDone();
      } else {
        toast("Rascunho salvo."); onSaved();
      }
    } catch (e) { setErr((e as Error).message); setPublishing(false); } finally { setBusy(null); }
  }

  const others = (crossOptions.data ?? []).filter((o) => o.service_code !== service.code);
  const grouped = others.reduce<Record<string, typeof others>>((acc, o) => { (acc[o.service_name] ??= []).push(o); return acc; }, {});
  const durOf = (ph: EPhase) => phaseDuration(ph.steps.map((s) => ({ duration_type: s.duration_type, days: s.days ? Number(s.days) : null })));
  const total = phases?.reduce((n, ph) => n + durOf(ph).days, 0) ?? 0;

  return (
    <Drawer open wide onClose={() => (dirty ? setLeaving(true) : onClose())}
      title={`Editar padrão · ${service.name}`}
      subtitle={`Rascunho v${template.version} · ${variantLabel(template)} · vale para novos projetos depois de publicado`}
      footer={
        <>
          <span className="subtext">{phases ? `${plural(phases.length, "fase", "fases")} · ~${total} dias úteis` : ""}{dirty ? " · alterações não salvas" : ""}</span>
          <span className="spacer" />
          <Button variant="secondary" loading={busy === "save"} disabled={!phases} onClick={() => save(false)}>Salvar rascunho</Button>
          <Button loading={busy === "publish"} disabled={!phases} onClick={() => setPublishing(true)}>Publicar versão {template.version}</Button>
        </>
      }>
      <div className="form">
        <div className="ed-help">
          <span><Icon name="sequence" size={14} /><strong>Fases</strong> acontecem uma depois da outra.</span>
          <span><Icon name="parallel" size={14} /><strong>Etapas da mesma fase</strong> acontecem ao mesmo tempo.</span>
          <span><Icon name="grip" size={14} />Arraste pela alça para mudar a etapa de lugar ou de fase.</span>
        </div>
        {err && <Alert tone="danger" title="Não foi salvo">{err}</Alert>}
        <Field label="Nome do padrão">{({ id }) => <Input id={id} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />}</Field>

        {!phases ? <Skeleton height={280} /> : (
          <div className="ph-list">
            {phases.map((ph, pi) => {
              const d = durOf(ph);
              return (
                <div key={ph.key}>
                  {pi > 0 && (
                    <div className="ph-gap">
                      <Icon name="sequence" size={16} className="ph-gap__arrow" />
                      <button type="button" className="ph-gap__btn" onClick={() => addPhaseAt(pi)}><Icon name="plus" size={14} /> Inserir fase aqui</button>
                    </div>
                  )}
                  <section className={cx("ph-edit", ph.steps.length > 1 && "ph-edit--parallel", over === `p${pi}` && "is-over")} aria-label={`Fase ${pi + 1}`}
                    onDragOver={(e: DragEvent) => { if (drag) { e.preventDefault(); setOver(`p${pi}`); } }}
                    onDrop={(e: DragEvent) => { e.preventDefault(); dropOn(pi, null); }}>
                    <header className="ph-edit__head">
                      <span className="phase__n">Fase {pi + 1}</span>
                      <span className="muted num">{d.days ? `${d.days} d.u.` : ""}{d.partial ? (d.days ? " + a definir" : "Prazo a definir") : ""}</span>
                      {ph.steps.length > 1 && <span className="phase__par"><Icon name="parallel" size={14} /> {ph.steps.length} ao mesmo tempo</span>}
                      <span className="grow" />
                      <Button variant="ghost" size="sm" iconOnly icon="chevronDown" className="flip" disabled={pi === 0} onClick={() => movePhase(pi, -1)}>Mover fase para cima</Button>
                      <Button variant="ghost" size="sm" iconOnly icon="chevronDown" disabled={pi === phases.length - 1} onClick={() => movePhase(pi, 1)}>Mover fase para baixo</Button>
                    </header>
                    <ul className="ph-edit__steps">
                      {ph.steps.map((s, si) => (
                        <li key={s.key} className={cx("es", drag?.p === pi && drag.s === si && "is-dragging", over === `${pi}.${si}` && "is-over")}
                          draggable={drag?.p === pi && drag.s === si}
                          onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.key); }}
                          onDragOver={(e) => { if (drag) { e.preventDefault(); e.stopPropagation(); setOver(`${pi}.${si}`); } }}
                          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOn(pi, si); }}
                          onDragEnd={() => { setDrag(null); setOver(null); }}>
                          <div className="es__main">
                            <span className="drag-grip" role="button" tabIndex={0} aria-label={`Mover ${s.name || "etapa"}`} title="Arraste para mover"
                              onPointerDown={() => setDrag({ p: pi, s: si })}><Icon name="grip" size={16} /></span>
                            <StepPicker className="es__name" library={library.data ?? []} value={s.name} label={`Etapa ${si + 1} da fase ${pi + 1}`}
                              invalid={missing && !s.name.trim()} onPick={(l) => fromLibrary(pi, si, l)} onCreate={permissions?.is_manager ? createInLibrary : undefined} />
                            <Select className="es__type" aria-label="Tipo de prazo" value={s.duration_type}
                              onChange={(e) => updateStep(pi, si, { duration_type: e.target.value as DurationType, showCross: e.target.value === "dependent" || s.showCross })}>
                              <option value="fixed">Dias úteis</option>
                              <option value="dependent">Conforme outro serviço</option>
                              <option value="external">Prazo de terceiros</option>
                              <option value="ongoing">Contínua</option>
                            </Select>
                            {s.duration_type === "fixed" ? (
                              <Input className="es__days" aria-label="Dias úteis" type="number" min={1} max={2000} inputMode="numeric" placeholder="dias"
                                value={s.days} onChange={(e) => updateStep(pi, si, { days: e.target.value })} />
                            ) : <span className="es__days es__days--none" aria-hidden="true" />}
                            <Button variant="ghost" size="sm" iconOnly icon={s.client_visible ? "user" : "lock"}
                              title={s.client_visible ? "O cliente vê esta etapa (clique para tornar interna)" : "Etapa interna: o cliente não vê (clique para mostrar)"}
                              onClick={() => updateStep(pi, si, { client_visible: !s.client_visible })}>
                              {s.client_visible ? "Cliente vê" : "Interna"}
                            </Button>
                            <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => removeStep(pi, si)}>Remover etapa</Button>
                          </div>
                          {(s.showCross || s.include_if?.length) ? (
                            <div className="es__extra">
                              {s.showCross && (
                                <Select aria-label="Aguarda etapa de outro serviço" value={s.cross} onChange={(e) => updateStep(pi, si, { cross: e.target.value })}>
                                  <option value="">{s.duration_type === "dependent" ? "Escolha de qual etapa de outro serviço depende (obrigatório)" : "Não aguarda outro serviço"}</option>
                                  {Object.entries(grouped).map(([svc, opts]) => (
                                    <optgroup key={svc} label={svc}>{opts.map((o) => <option key={`${o.service_code}.${o.code}`} value={`${o.service_code}.${o.code}`}>Aguarda: {o.name}</option>)}</optgroup>
                                  ))}
                                </Select>
                              )}
                              {s.include_if?.length ? <span className="subtext">Só entra se o projeto contratar: {s.include_if.join(", ").replaceAll("_", " ")}</span> : null}
                            </div>
                          ) : (
                            <button type="button" className="es__link" onClick={() => updateStep(pi, si, { showCross: true })}>+ Aguardar etapa de outro serviço</button>
                          )}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="ph-edit__add" onClick={() => mutate((ps) => { ps[pi].steps.push(newStep()); return ps; })}>
                      <Icon name="parallel" size={14} /> Adicionar etapa simultânea nesta fase
                    </button>
                  </section>
                </div>
              );
            })}
            <div className="ph-gap"><Icon name="sequence" size={16} className="ph-gap__arrow" /></div>
            <button type="button" className="ph-new" onClick={() => addPhaseAt(phases.length)}><Icon name="plus" size={16} /> Adicionar fase no final</button>
          </div>
        )}
      </div>

      <Modal open={publishing} onClose={() => setPublishing(false)} title={`Publicar versão ${template.version}?`}
        footer={<><Button variant="ghost" onClick={() => setPublishing(false)}>Cancelar</Button>
          <Button loading={busy === "publish"} onClick={() => save(true)}>Publicar</Button></>}>
        <p>Novos projetos com {service.name} passam a usar este padrão. Projetos já iniciados não mudam.</p>
        <Field label="Nota da versão" hint="Opcional. Aparece no histórico.">
          {({ id }) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: renderização junto com alterações" />}
        </Field>
      </Modal>
      <ConfirmDialog open={leaving} title="Sair sem salvar?" danger message="As alterações feitas desde o último salvamento serão perdidas."
        confirmLabel="Sair sem salvar" onCancel={() => setLeaving(false)} onConfirm={() => { setLeaving(false); onClose(); }} />
    </Drawer>
  );
}

/* ---------- Configurações do serviço ---------- */
function OptionRow({ checked, onChange, title, text }: { checked: boolean; onChange: (v: boolean) => void; title: string; text: ReactNode }) {
  return (
    <label className={cx("opt", checked && "is-on")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="opt__title">{title}</span><span className="opt__text">{text}</span></span>
    </label>
  );
}

function ServiceSettings({ service, onClose, onSaved }: { service: CatalogService; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [b2c, setB2c] = useState(service.available_for_b2c);
  const [b2b, setB2b] = useState(service.available_for_b2b);
  const [area, setArea] = useState(service.requires_area_rule);
  const [aliases, setAliases] = useState(service.aliases.join(", "));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Drawer open onClose={onClose} title="Configurações do serviço" subtitle={service.name}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} onClick={async () => {
          if (!b2c && !b2b) { setErr("O serviço precisa atender B2C, B2B ou ambos."); return; }
          setBusy(true); setErr(null);
          try {
            await api.updateService(service.id, { available_for_b2c: b2c, available_for_b2b: b2b, requires_area_rule: area,
              aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean) });
            toast("Serviço atualizado."); onSaved();
          } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Salvar</Button></>}>
      <div className="form">
        {err && <Alert tone="danger">{err}</Alert>}
        <fieldset className="form__group">
          <legend className="label">Quem pode contratar</legend>
          <OptionRow checked={b2c} onChange={setB2c} title="Clientes B2C" text="Pessoa física (residencial)." />
          <OptionRow checked={b2b} onChange={setB2b} title="Clientes B2B" text="Empresas, incorporadoras e construtoras." />
        </fieldset>
        <fieldset className="form__group">
          <legend className="label">Prazos</legend>
          <OptionRow checked={area} onChange={setArea} title="Prazos variam com a área do projeto"
            text="Use variantes por faixa de área (ex.: até 500 m² e acima de 500 m²). Sem área informada, o projeto fica aguardando a área." />
        </fieldset>
        <Field label="Outros nomes usados no CRM" hint="Separe por vírgula. A Central de Entrada reconhece o serviço por estes nomes.">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={aliases} onChange={(e) => setAliases(e.target.value)} />}
        </Field>
      </div>
    </Drawer>
  );
}

function NewVariantDrawer({ service, onClose, onCreated }: { service: CatalogService; onClose: () => void; onCreated: (id: string) => void }) {
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
        }}>Criar e editar</Button></>}>
      <div className="form">
        <p className="subtext">Variantes servem quando as etapas ou prazos mudam conforme o tipo de cliente ou a área. Exemplo: Interiores até 500 m² e acima de 500 m². As faixas de área não podem se sobrepor.</p>
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

/* ---------- Exclusão com dupla confirmação ---------- */
function DeleteTemplateDialog({ service, variant, variantsCount, templateId, projects, onClose, onDeleted }: {
  service: CatalogService; variant: Variant; variantsCount: number; templateId: string; projects: number; onClose: () => void; onDeleted: () => void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const match = typed.trim().toLowerCase() === service.name.trim().toLowerCase();
  return (
    <Modal open onClose={onClose} title={`Excluir padrão de ${service.name}?`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="danger" disabled={!match} loading={busy} onClick={async () => {
          setBusy(true); setErr(null);
          try { await api.deleteTemplateVariant(templateId, typed); toast("Padrão excluído. O histórico foi preservado."); onDeleted(); }
          catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Excluir padrão</Button></>}>
      <div className="stack">
        {variantsCount > 1 && <p>Variante: <strong>{variantLabel(variant)}</strong></p>}
        <ul className="del-facts">
          <li><Icon name="alert" size={16} /> Novos projetos com este serviço{variantsCount > 1 ? " nesta variante" : ""} ficarão “Sem cronograma padrão” até um novo padrão ser criado.</li>
          <li><Icon name="checkCircle" size={16} /> {projects ? `${plural(projects, "projeto em andamento usa", "projetos em andamento usam")} este padrão e não serão alterados.` : "Nenhum projeto em andamento usa este padrão."}</li>
          <li><Icon name="clock" size={16} /> O histórico de versões fica guardado e pode servir de base para um novo padrão.</li>
        </ul>
        {err && <Alert tone="danger">{err}</Alert>}
        <Field label={`Para confirmar, digite o nome do serviço: ${service.name}`}>
          {({ id }) => <Input id={id} value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} placeholder={service.name} />}
        </Field>
      </div>
    </Modal>
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
  const [order, setOrder] = useState<TaskLibraryItem[]>([]);
  useEffect(() => { setOrder((lib.data ?? []).filter((l) => l.active)); }, [lib.data]);
  const removed = (lib.data ?? []).filter((l) => !l.active);

  const sortable = canAdd && !q;
  const sort = useDragSort(order, async (next) => {
    const prev = order;
    setOrder(next);
    try { await api.reorderTaskLibrary(next.map((l) => l.id)); }
    catch (e) { setOrder(prev); toast((e as Error).message, "error"); }
  });
  const list = q ? order.filter((l) => l.name.toLowerCase().includes(q.toLowerCase())) : order;
  const canEditItem = (l: TaskLibraryItem) => isGlobal || (canAdd && l.created_by === permissions?.profile_id);

  return (
    <div className="stack">
      <div className="row-between">
        <SearchInput placeholder="Buscar etapa" aria-label="Buscar etapa" value={q} onChange={(e) => setQ(e.target.value)} />
        {canAdd && <Button icon="plus" onClick={() => setEditing("new")}>Registrar etapa</Button>}
      </div>
      <Alert tone="info">
        A biblioteca guarda os nomes de etapas para reutilizar. A ordem, as fases e os prazos de cada serviço são definidos em “Padrões por serviço”.
        {sortable ? " Arraste pela alça para organizar como as opções aparecem." : ""}
      </Alert>
      {lib.error ? <LoadError message={lib.error} onRetry={lib.reload} /> : lib.loading && !lib.data ? <Skeleton height={300} radius={16} /> :
        list.length === 0 ? <Card><EmptyState icon="search" title={q ? "Nenhuma etapa encontrada." : "Nenhuma etapa registrada."} /></Card> : (
          <Card flush>
            <ol className="tasklist lib-list">
              {list.map((l, i) => (
                <li key={l.id} {...(sortable ? sort.row(i) : {})}
                  className={cx(sortable && sort.dragging === i && "is-dragging", sortable && sort.over === i && sort.dragging !== i && "is-over")}>
                  <div className="task">
                    {sortable && <span className="drag-grip" {...sort.grip(i, `Mover ${l.name}`)}><Icon name="grip" size={16} /></span>}
                    <span className="task__main">
                      <span className="task__name">{l.name}</span>
                      {l.description && <span className="task__meta truncate">{l.description}</span>}
                    </span>
                    <span className="task__side">
                      <span className="muted">{l.duration_type === "fixed" ? (l.default_duration_days ? `Sugestão: ${l.default_duration_days} d.u.` : "Sem prazo sugerido") : DURATION_TYPE_LABEL[l.duration_type]}</span>
                      {canEditItem(l) && <Button variant="ghost" size="sm" iconOnly icon="edit" onClick={() => setEditing(l)}>Editar</Button>}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        )}
      {removed.length > 0 && (
        <details className="versions">
          <summary><Icon name="clock" size={16} /> Excluídas da biblioteca <span className="muted">· {removed.length}</span></summary>
          <ul className="history">
            {removed.map((l) => (
              <li key={l.id}><span className="history__what">{l.name}</span>
                {canEditItem(l) && (
                  <span className="history__when"><Button size="sm" variant="ghost" icon="refresh" onClick={async () => {
                    try { await api.setTaskLibraryActive(l.id, true); toast("Etapa restaurada."); void lib.reload(); }
                    catch (e) { toast((e as Error).message, "error"); }
                  }}>Restaurar</Button></span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {editing && (
        <LibraryDrawer item={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); toast(msg); void lib.reload(); }} />
      )}
    </div>
  );
}

function LibraryDrawer({ item, onClose, onSaved }: { item: TaskLibraryItem | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const { permissions } = useAuth();
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [kind, setKind] = useState<"fixed" | "external" | "ongoing">(item?.duration_type === "external" || item?.duration_type === "ongoing" ? item.duration_type : "fixed");
  const [days, setDays] = useState(item?.default_duration_days ? String(item.default_duration_days) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <Drawer open onClose={onClose} title={item ? "Editar etapa" : "Registrar etapa"} subtitle="Biblioteca de etapas"
      footer={<>
        {item && <Button variant="danger-ghost" icon="x" onClick={() => setConfirmDelete(true)}>Excluir</Button>}
        <span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} disabled={name.trim().length < 2} onClick={async () => {
          setBusy(true); setErr(null);
          try {
            await api.saveTaskLibraryItem({ id: item?.id, name, description, duration_type: kind, default_duration_days: days ? Number(days) : null,
              created_by: permissions?.profile_id ?? null });
            onSaved(item ? "Etapa atualizada." : "Etapa registrada.");
          } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }}>Salvar</Button></>}>
      <div className="form">
        {err && <Alert tone="danger">{err}</Alert>}
        <Field label="Nome" required>{({ id }) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Vídeo 3D" />}</Field>
        <Field label="Descrição" hint="Opcional.">{({ id }) => <textarea id={id} className="input textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Segmented<"fixed" | "external" | "ongoing"> label="Tipo de prazo" value={kind} onChange={setKind}
          options={[{ value: "fixed", label: "Dias úteis" }, { value: "external", label: "Terceiros" }, { value: "ongoing", label: "Contínua" }]} />
        {kind === "fixed" && (
          <Field label="Prazo sugerido (dias úteis)" hint="Opcional. Preenche automaticamente ao escolher a etapa; cada padrão pode ajustar.">
            {({ id }) => <Input id={id} type="number" min={1} max={2000} value={days} onChange={(e) => setDays(e.target.value)} />}
          </Field>
        )}
      </div>
      <ConfirmDialog open={confirmDelete} danger title={`Excluir “${item?.name}” da biblioteca?`}
        message="A etapa deixa de aparecer como opção. Padrões e projetos que já usam esta etapa não mudam. Você pode restaurá-la depois."
        confirmLabel="Excluir da biblioteca" loading={busy} onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          if (!item) return;
          setBusy(true);
          try { await api.setTaskLibraryActive(item.id, false); onSaved("Etapa excluída da biblioteca."); }
          catch (e) { setErr((e as Error).message); setConfirmDelete(false); } finally { setBusy(false); }
        }} />
    </Drawer>
  );
}
