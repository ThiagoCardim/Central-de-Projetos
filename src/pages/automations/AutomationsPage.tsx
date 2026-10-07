import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, LoadError, Select, Skeleton, Tabs } from "@/components/ui/primitives";
import { ConfirmDialog, Drawer, useToast } from "@/components/ui/overlays";
import { Icon, type IconName } from "@/components/ui/Icon";
import type {
  AutomationAction, AutomationActionType, AutomationConditions, AutomationRule, AutomationRun, AutomationTrigger,
  BoardColumn, CatalogService, ClientType, ProjectStatus, StaffMember, TaskLibraryItem,
} from "@/types/domain";
import { cx, formatDateTime, plural, PROJECT_STATUS_LABEL } from "@/utils/format";
import { stepFilterKey } from "@/pages/schedule/model";

/* ==========================================================================
   Vocabulário (gatilhos, condições, ações)
   ========================================================================== */
type CondKey = keyof AutomationConditions;
const TRIGGERS: { value: AutomationTrigger; label: string; when: string; text: string; icon: IconName; conds: CondKey[]; task?: boolean }[] = [
  { value: "project_created", label: "Projeto entrou", when: "Quando um projeto entrar na plataforma", text: "Venda processada pela Central de Entrada.", icon: "inbox", conds: ["services", "client_types"] },
  { value: "project_status_changed", label: "Status do projeto mudou", when: "Quando o status do projeto mudar", text: "Distribuído, equipe definida, pausado, concluído…", icon: "flag", conds: ["to_status", "services", "client_types"] },
  { value: "task_started", label: "Etapa iniciada", when: "Quando uma etapa for iniciada", text: "Alguém marcou a etapa como em andamento.", icon: "target", conds: ["steps", "services", "client_types"], task: true },
  { value: "task_completed", label: "Etapa concluída", when: "Quando uma etapa for concluída", text: "A etapa foi marcada como concluída.", icon: "checkCircle", conds: ["steps", "services", "client_types"], task: true },
  { value: "task_waiting_client", label: "Etapa aguardando cliente", when: "Quando uma etapa ficar aguardando o cliente", text: "Depende de retorno ou aprovação do cliente.", icon: "pause", conds: ["steps", "services", "client_types"], task: true },
  { value: "task_overdue", label: "Etapa atrasou", when: "Quando uma etapa atrasar", text: "Verificado a cada hora; dispara uma vez por prazo.", icon: "alert", conds: ["steps", "services", "client_types"], task: true },
  { value: "service_added", label: "Serviço adicional contratado", when: "Quando um serviço adicional for contratado", text: "Novo serviço chegou para um projeto existente.", icon: "plus", conds: ["services", "client_types"] },
  { value: "card_moved", label: "Card movido no quadro", when: "Quando um card for movido no quadro", text: "Movido por alguém ou por outra automação.", icon: "grip", conds: ["columns", "services", "client_types"] },
];
const TRIGGER = Object.fromEntries(TRIGGERS.map((t) => [t.value, t])) as Record<AutomationTrigger, (typeof TRIGGERS)[number]>;

const ACTIONS: { value: AutomationActionType; label: string; icon: IconName }[] = [
  { value: "move_card", label: "Mover card no quadro", icon: "folder" },
  { value: "notify", label: "Enviar aviso", icon: "bell" },
  { value: "set_task_responsible", label: "Definir responsável de uma etapa", icon: "user" },
];
const RECIPIENTS: { value: string; label: string; task?: boolean }[] = [
  { value: "project_lead", label: "Líder da área do serviço" },
  { value: "task_responsible", label: "Responsável pela etapa", task: true },
  { value: "service_responsible", label: "Responsável direto do serviço" },
  { value: "project_team", label: "Toda a equipe do projeto" },
  { value: "unit_managers", label: "Gestores da unidade" },
];
const STATUSES: ProjectStatus[] = ["awaiting_team_assignment", "in_progress", "on_hold", "completed", "cancelled"];
const VARIABLES = ["{projeto}", "{codigo}", "{cliente}", "{etapa}", "{servico}", "{coluna}"];

interface Ctx { columns: BoardColumn[]; services: CatalogService[]; library: TaskLibraryItem[]; staff: StaffMember[] }

/* ---------- Frase legível da regra ---------- */
function joinPt(list: string[], sep = "ou") {
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} ${sep} ${list[list.length - 1]}`;
}
function describe(rule: Pick<AutomationRule, "trigger" | "conditions" | "actions">, c: Ctx): { when: string; ifs: string[]; thens: string[] } {
  const cond = rule.conditions ?? {};
  const svc = (codes: string[]) => codes.map((x) => c.services.find((s) => s.code === x)?.name ?? x);
  const stepName = (k: string) => c.library.find((l) => stepFilterKey(l.name) === k)?.name ?? k;
  const col = (id?: string) => c.columns.find((x) => x.id === id)?.name ?? "coluna excluída";
  const person = (id: string) => c.staff.find((s) => `user:${s.id}` === id)?.name ?? "pessoa";
  const ifs: string[] = [];
  if (cond.steps?.length) ifs.push(`a etapa for ${joinPt(cond.steps.map(stepName))}`);
  if (cond.services?.length) ifs.push(`o serviço for ${joinPt(svc(cond.services))}`);
  if (cond.to_status?.length) ifs.push(`o novo status for ${joinPt(cond.to_status.map((s) => PROJECT_STATUS_LABEL[s].toLowerCase()))}`);
  if (cond.columns?.length) ifs.push(`a coluna for ${joinPt(cond.columns.map((x) => `“${col(x)}”`))}`);
  if (cond.client_types?.length) ifs.push(`o cliente for ${joinPt(cond.client_types.map((x) => x.toUpperCase()))}`);
  const thens = rule.actions.map((a) => {
    if (a.type === "move_card") return `mover o card para “${col(a.column_id)}”`;
    if (a.type === "notify") {
      const who = (a.recipients ?? []).map((r) => r.startsWith("user:") ? person(r) : RECIPIENTS.find((x) => x.value === r)?.label.toLowerCase() ?? r);
      return `avisar ${joinPt(who, "e") || "—"}`;
    }
    const assignee = a.assignee === "service_responsible" ? "o responsável direto do serviço" : person(a.assignee ?? "");
    return `passar “${a.step ?? "etapa"}” para ${assignee}`;
  });
  return { when: TRIGGER[rule.trigger]?.when ?? "Quando…", ifs, thens };
}
function Sentence({ rule, ctx }: { rule: Pick<AutomationRule, "trigger" | "conditions" | "actions">; ctx: Ctx }) {
  const d = describe(rule, ctx);
  return (
    <p className="auto-sentence">
      <span className="auto-sentence__k">{d.when}</span>
      {d.ifs.length > 0 && <>, se {d.ifs.join(" e ")}</>}
      {d.thens.length > 0 ? <> → <strong>{d.thens.join("; ")}</strong></> : <> → <span className="muted">escolha o que fazer</span></>}
    </p>
  );
}

/* ==========================================================================
   Página
   ========================================================================== */
export function AutomationsPage() {
  useDocumentTitle("Automações");
  const { permissions } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<"rules" | "runs">("rules");
  const rules = useAsync(() => api.listAutomations(), []);
  const runs = useAsync(() => api.listAutomationRuns(150), []);
  const ctxData = useAsync(async (): Promise<Ctx> => {
    const [board, catalog, library, staff] = await Promise.all([
      api.loadBoard(), api.listCatalog(), api.listTaskLibrary(),
      permissions?.tenant_id ? api.listStaff(permissions.tenant_id) : Promise.resolve([] as StaffMember[]),
    ]);
    return { columns: board.columns, services: catalog.services.filter((s) => s.active), library, staff };
  }, [permissions?.tenant_id]);
  const [editing, setEditing] = useState<Partial<AutomationRule> | null>(null);
  const [removing, setRemoving] = useState<AutomationRule | null>(null);
  const [busy, setBusy] = useState(false);
  const ctx = ctxData.data;

  const lastRun = useMemo(() => {
    const m = new Map<string, AutomationRun>();
    (runs.data ?? []).forEach((r) => { if (!m.has(r.rule_id)) m.set(r.rule_id, r); });
    return m;
  }, [runs.data]);

  const reloadAll = () => { void rules.reload(); void runs.reload(); };
  async function toggle(r: AutomationRule) {
    try { await api.setAutomationActive(r.id, !r.active); toast(r.active ? "Automação pausada." : "Automação ativada."); void rules.reload(); }
    catch (e) { toast((e as Error).message, "error"); }
  }

  const presets = ctx ? PRESETS(ctx) : [];

  return (
    <div className="page">
      <PageHead title="Automações"
        subtitle="Monte regras do tipo “quando isto acontecer, faça aquilo”. Valem para os projetos da sua unidade e ficam registradas no histórico."
        actions={<Button icon="plus" disabled={!ctx} onClick={() => setEditing({ trigger: "task_completed", conditions: {}, actions: [], active: true, name: "" })}>Nova automação</Button>} />
      <Tabs<"rules" | "runs"> label="Seções" value={tab} onChange={setTab} tabs={[
        { value: "rules", label: "Automações", count: rules.data?.length },
        { value: "runs", label: "Histórico de execuções", count: runs.data?.length },
      ]} />

      {tab === "rules" && (
        rules.error ? <LoadError message={rules.error} onRetry={rules.reload} /> :
        ctxData.error ? <LoadError message={ctxData.error} onRetry={ctxData.reload} /> :
        (!rules.data || !ctx) ? <Skeleton height={240} radius={16} /> : (
          <>
            {rules.data.length === 0 ? (
              <Card>
                <EmptyState icon="zap" title="Nenhuma automação ainda."
                  text="Comece do zero ou use um dos modelos abaixo e ajuste como quiser." />
              </Card>
            ) : (
              <ul className="auto-list">
                {rules.data.map((r) => {
                  const lr = lastRun.get(r.id);
                  return (
                    <li key={r.id} className={cx("auto-card", !r.active && "is-paused")}>
                      <button type="button" role="switch" aria-checked={r.active} className="switch" onClick={() => toggle(r)}
                        aria-label={r.active ? `Pausar ${r.name}` : `Ativar ${r.name}`}><span /></button>
                      <div className="auto-card__main">
                        <div className="auto-card__head">
                          <span className="auto-card__name">{r.name}</span>
                          {!r.active && <Badge>Pausada</Badge>}
                          {lr && !lr.ok && <Badge tone="danger" dot>Falhou na última execução</Badge>}
                        </div>
                        <Sentence rule={r} ctx={ctx} />
                        <span className="subtext">
                          {r.run_count ? `${plural(r.run_count, "execução", "execuções")} · última em ${formatDateTime(r.last_run_at)}` : "Ainda não executou"}
                        </span>
                      </div>
                      <div className="auto-card__actions">
                        <Button variant="ghost" size="sm" icon="edit" onClick={() => setEditing(r)}>Editar</Button>
                        <Button variant="ghost" size="sm" iconOnly icon="plus" title="Duplicar"
                          onClick={() => setEditing({ ...r, id: undefined, name: `${r.name} (cópia)`, active: false })}>Duplicar</Button>
                        <Button variant="ghost" size="sm" iconOnly icon="x" title="Excluir" onClick={() => setRemoving(r)}>Excluir</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <section className="auto-presets" aria-label="Modelos prontos">
              <h2 className="label">Modelos prontos</h2>
              <div className="auto-presets__grid">
                {presets.map((p) => (
                  <button key={p.name} type="button" className="auto-preset" onClick={() => setEditing({ ...p, active: true })}>
                    <Icon name={TRIGGER[p.trigger].icon} size={18} />
                    <span className="auto-preset__name">{p.name}</span>
                    <Sentence rule={p} ctx={ctx} />
                  </button>
                ))}
              </div>
            </section>
          </>
        )
      )}

      {tab === "runs" && <RunsList runs={runs} />}

      {editing && ctx && (
        <AutomationEditor initial={editing} ctx={ctx} onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); toast(msg); reloadAll(); }} />
      )}
      <ConfirmDialog open={!!removing} danger title={`Excluir a automação “${removing?.name ?? ""}”?`}
        message="Ela para de funcionar imediatamente. O histórico de execuções continua guardado. Se quiser só interromper por um tempo, use o botão de pausa."
        confirmLabel="Excluir automação" loading={busy} onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          try { await api.archiveAutomation(removing.id); toast("Automação excluída."); setRemoving(null); reloadAll(); }
          catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
        }} />
    </div>
  );
}

function PRESETS(c: Ctx): (Pick<AutomationRule, "name" | "trigger" | "conditions" | "actions">)[] {
  const col = (name: string) => c.columns.find((x) => stepFilterKey(x.name) === stepFilterKey(name))?.id ?? c.columns[0]?.id;
  return [
    { name: "Avisar quando uma etapa atrasar", trigger: "task_overdue", conditions: {},
      actions: [{ type: "notify", recipients: ["project_lead", "task_responsible"], title: "Etapa atrasada: {etapa}", message: "{projeto} ({codigo}) · {servico}" }] },
    { name: "Projeto iniciado vai para “Em andamento”", trigger: "project_status_changed", conditions: { to_status: ["in_progress"] },
      actions: [{ type: "move_card", column_id: col("Em andamento") }] },
    { name: "Avisar o líder quando aguardar o cliente", trigger: "task_waiting_client", conditions: {},
      actions: [{ type: "notify", recipients: ["project_lead"], title: "Aguardando cliente: {etapa}", message: "{projeto} · {cliente}" }] },
    { name: "Serviço adicional para revisão", trigger: "service_added", conditions: {},
      actions: [{ type: "notify", recipients: ["unit_managers"], title: "Serviço adicional: {servico}", message: "{projeto} precisa de revisão para entrar no cronograma." }] },
    { name: "Projeto concluído vai para “Encerrados”", trigger: "project_status_changed", conditions: { to_status: ["completed", "cancelled"] },
      actions: [{ type: "move_card", column_id: col("Encerrados") }] },
  ];
}

/* ==========================================================================
   Histórico
   ========================================================================== */
const ACTION_LABEL: Record<AutomationActionType, string> = { move_card: "Mover card", notify: "Aviso", set_task_responsible: "Responsável" };
function RunsList({ runs }: { runs: ReturnType<typeof useAsync<AutomationRun[]>> }) {
  const [onlyErrors, setOnlyErrors] = useState(false);
  if (runs.error) return <LoadError message={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <Skeleton height={240} radius={16} />;
  const list = runs.data.filter((r) => !onlyErrors || !r.ok);
  return (
    <div className="stack">
      <label className="check"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Mostrar só execuções com falha</label>
      {list.length === 0 ? <Card><EmptyState icon="clock" title={onlyErrors ? "Nenhuma falha registrada." : "Nenhuma execução ainda."}
        text="Cada vez que uma automação dispara, ela aparece aqui com o resultado de cada ação." /></Card> : (
        <Card flush>
          <ul className="auto-runs">
            {list.map((r) => (
              <li key={r.id}>
                <span className={cx("auto-runs__dot", r.ok ? "is-ok" : "is-err")} aria-hidden="true" />
                <div className="auto-runs__main">
                  <span className="auto-runs__title">
                    <strong>{r.rule?.name ?? "Automação"}</strong>
                    {r.project && <> · <Link to={`/projetos/${r.project.id}`}>{r.project.code ?? r.project.name}</Link> {r.project.name}</>}
                  </span>
                  <span className="subtext">
                    {TRIGGER[r.event]?.label}{r.context.task_name ? `: ${r.context.task_name}` : ""}{r.context.column_name ? `: ${r.context.column_name}` : ""}
                    {r.context.service_name ? ` · ${r.context.service_name}` : ""}
                  </span>
                  <span className="auto-runs__results">
                    {r.results.map((x, i) => (
                      <span key={i} className={cx("auto-runs__res", !x.ok && "is-err")}>{ACTION_LABEL[x.type] ?? x.type}: {x.message}</span>
                    ))}
                  </span>
                </div>
                <span className="auto-runs__when num">{formatDateTime(r.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ==========================================================================
   Editor
   ========================================================================== */
function AutomationEditor({ initial, ctx, onClose, onSaved }: {
  initial: Partial<AutomationRule>; ctx: Ctx; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [trigger, setTrigger] = useState<AutomationTrigger>(initial.trigger ?? "task_completed");
  const [cond, setCond] = useState<AutomationConditions>(initial.conditions ?? {});
  const [actions, setActions] = useState<AutomationAction[]>(initial.actions?.length ? initial.actions : []);
  const [active, setActive] = useState(initial.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = TRIGGER[trigger];

  // Limpa condições que não valem para o gatilho escolhido
  useEffect(() => {
    setCond((c) => Object.fromEntries(Object.entries(c).filter(([k]) => t.conds.includes(k as CondKey))) as AutomationConditions);
    if (!t.task) setActions((as) => as.map((a) => a.type === "notify" ? { ...a, recipients: (a.recipients ?? []).filter((r) => r !== "task_responsible") } : a));
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateAction = (i: number, patch: Partial<AutomationAction>) => setActions((as) => as.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const addAction = (type: AutomationActionType) => setActions((as) => [...as,
    type === "move_card" ? { type, column_id: ctx.columns[0]?.id }
      : type === "notify" ? { type, recipients: ["project_lead"], title: "", message: "" }
      : { type, step: "", assignee: "service_responsible" }]);

  async function save() {
    setErr(null);
    if (!name.trim()) { setErr("Dê um nome para a automação."); return; }
    if (!actions.length) { setErr("Adicione ao menos uma ação em “Então”."); return; }
    setBusy(true);
    try {
      await api.saveAutomation(initial.id ?? null, { name: name.trim(), trigger, conditions: cond, actions, active });
      onSaved(initial.id ? "Automação atualizada." : active ? "Automação criada e ativa." : "Automação criada (pausada).");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const serviceOpts = ctx.services.map((s) => ({ value: s.code, label: s.name }));
  const stepOpts = ctx.library.map((l) => ({ value: stepFilterKey(l.name), label: l.name }));

  return (
    <Drawer open wide onClose={onClose} title={initial.id ? "Editar automação" : "Nova automação"}
      subtitle="Quando algo acontecer num projeto da sua unidade, a plataforma faz o que você definir."
      footer={<>
        <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Ativa</label>
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} onClick={save}>Salvar automação</Button>
      </>}>
      <div className="form">
        <div className="auto-preview"><Icon name="zap" size={16} /><Sentence rule={{ trigger, conditions: cond, actions }} ctx={ctx} /></div>
        {err && <Alert tone="danger" title="Não foi salvo">{err}</Alert>}
        <Field label="Nome da automação" required>
          {({ id }) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Estudo concluído vai para revisão" />}
        </Field>

        <Step n={1} title="Quando" text="O acontecimento que dispara a automação.">
          <div className="auto-triggers" role="radiogroup" aria-label="Gatilho">
            {TRIGGERS.map((x) => (
              <button key={x.value} type="button" role="radio" aria-checked={trigger === x.value}
                className={cx("auto-trigger", trigger === x.value && "is-on")} onClick={() => setTrigger(x.value)}>
                <Icon name={x.icon} size={18} />
                <span className="auto-trigger__label">{x.label}</span>
                <span className="auto-trigger__text">{x.text}</span>
              </button>
            ))}
          </div>
        </Step>

        <Step n={2} title="Somente se" text="Opcional. Sem condições, vale para todos os projetos da unidade.">
          <div className="auto-conds">
            {t.conds.includes("steps") && (
              <ChipPicker label="Etapa" empty="Qualquer etapa" options={stepOpts} value={cond.steps ?? []}
                onChange={(v) => setCond((c) => ({ ...c, steps: v }))} />
            )}
            {t.conds.includes("to_status") && (
              <ChipPicker label="Novo status do projeto" empty="Qualquer mudança" value={cond.to_status ?? []}
                options={STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABEL[s] }))}
                onChange={(v) => setCond((c) => ({ ...c, to_status: v as ProjectStatus[] }))} />
            )}
            {t.conds.includes("columns") && (
              <ChipPicker label="Coluna de destino" empty="Qualquer coluna" options={ctx.columns.map((c) => ({ value: c.id, label: c.name }))}
                value={cond.columns ?? []} onChange={(v) => setCond((c) => ({ ...c, columns: v }))} />
            )}
            {t.conds.includes("services") && (
              <ChipPicker label="Serviço" empty="Qualquer serviço" options={serviceOpts} value={cond.services ?? []}
                onChange={(v) => setCond((c) => ({ ...c, services: v }))} />
            )}
            {t.conds.includes("client_types") && (
              <ChipPicker label="Tipo de cliente" empty="B2C e B2B" options={[{ value: "b2c", label: "B2C" }, { value: "b2b", label: "B2B" }]}
                value={cond.client_types ?? []} onChange={(v) => setCond((c) => ({ ...c, client_types: v as ClientType[] }))} />
            )}
          </div>
        </Step>

        <Step n={3} title="Então" text="Uma ou mais ações, executadas na ordem.">
          <ol className="auto-actions">
            {actions.map((a, i) => (
              <li key={i} className="auto-action">
                <div className="auto-action__head">
                  <span className="auto-action__n">{i + 1}</span>
                  <Icon name={ACTIONS.find((x) => x.value === a.type)!.icon} size={16} />
                  <strong className="grow">{ACTIONS.find((x) => x.value === a.type)!.label}</strong>
                  <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}>Remover ação</Button>
                </div>
                <ActionFields action={a} ctx={ctx} taskTrigger={!!t.task} stepOpts={stepOpts} serviceOpts={serviceOpts}
                  onChange={(patch) => updateAction(i, patch)} />
              </li>
            ))}
          </ol>
          <div className="auto-add">
            {ACTIONS.map((x) => (
              <Button key={x.value} variant="outline" size="sm" icon="plus" onClick={() => addAction(x.value)}>{x.label}</Button>
            ))}
          </div>
        </Step>
      </div>
    </Drawer>
  );
}

function Step({ n, title, text, children }: { n: number; title: string; text: string; children: ReactNode }) {
  return (
    <section className="auto-step" aria-label={title}>
      <header className="auto-step__head"><span className="auto-step__n">{n}</span><span><strong>{title}</strong><span className="subtext"> · {text}</span></span></header>
      {children}
    </section>
  );
}

function ActionFields({ action: a, ctx, taskTrigger, stepOpts, serviceOpts, onChange }: {
  action: AutomationAction; ctx: Ctx; taskTrigger: boolean; stepOpts: { value: string; label: string }[];
  serviceOpts: { value: string; label: string }[]; onChange: (p: Partial<AutomationAction>) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const [focus, setFocus] = useState<"title" | "message">("message");
  if (a.type === "move_card") {
    return (
      <Field label="Para a coluna">
        {({ id }) => (
          <Select id={id} value={a.column_id ?? ""} onChange={(e) => onChange({ column_id: e.target.value })}>
            {ctx.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
      </Field>
    );
  }
  if (a.type === "notify") {
    const rec = a.recipients ?? [];
    const toggle = (v: string) => onChange({ recipients: rec.includes(v) ? rec.filter((x) => x !== v) : [...rec, v] });
    const people = rec.filter((r) => r.startsWith("user:")).map((r) => r.slice(5));
    const insert = (v: string) => {
      if (focus === "title") onChange({ title: `${a.title ?? ""}${v}` }); else onChange({ message: `${a.message ?? ""}${v}` });
      (focus === "title" ? titleRef.current : msgRef.current)?.focus();
    };
    return (
      <div className="stack" style={{ gap: 12 }}>
        <fieldset className="form__group">
          <legend className="label">Quem recebe</legend>
          <div className="auto-recipients">
            {RECIPIENTS.filter((r) => !r.task || taskTrigger).map((r) => (
              <label key={r.value} className="check"><input type="checkbox" checked={rec.includes(r.value)} onChange={() => toggle(r.value)} /> {r.label}</label>
            ))}
          </div>
          <ChipPicker label="Pessoas específicas" empty="Ninguém além dos acima" value={people}
            options={ctx.staff.map((s) => ({ value: s.id, label: s.name }))}
            onChange={(v) => onChange({ recipients: [...rec.filter((r) => !r.startsWith("user:")), ...v.map((x) => `user:${x}`)] })} />
        </fieldset>
        <Field label="Título do aviso" required>
          {({ id }) => <Input id={id} ref={titleRef} value={a.title ?? ""} maxLength={140} onFocus={() => setFocus("title")}
            onChange={(e) => onChange({ title: e.target.value })} placeholder="Ex.: {etapa} concluída" />}
        </Field>
        <Field label="Mensagem" hint="Opcional.">
          {({ id }) => <textarea id={id} ref={msgRef} className="input textarea" rows={2} value={a.message ?? ""} onFocus={() => setFocus("message")}
            onChange={(e) => onChange({ message: e.target.value })} placeholder="Ex.: {projeto} · {servico}" />}
        </Field>
        <div className="auto-vars"><span className="subtext">Inserir:</span>
          {VARIABLES.map((v) => <button key={v} type="button" className="chip" onClick={() => insert(v)}>{v}</button>)}
        </div>
      </div>
    );
  }
  return (
    <div className="form__cols">
      <Field label="Etapa">
        {({ id }) => (
          <Select id={id} value={a.step ?? ""} onChange={(e) => onChange({ step: e.target.value })}>
            <option value="">Escolha a etapa</option>
            {stepOpts.map((s) => <option key={s.value} value={s.label}>{s.label}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Do serviço">
        {({ id }) => (
          <Select id={id} value={a.service ?? ""} onChange={(e) => onChange({ service: e.target.value || undefined })}>
            <option value="">Qualquer serviço</option>
            {serviceOpts.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        )}
      </Field>
      <Field label="Novo responsável">
        {({ id }) => (
          <Select id={id} value={a.assignee ?? ""} onChange={(e) => onChange({ assignee: e.target.value })}>
            <option value="service_responsible">Responsável direto do serviço</option>
            {ctx.staff.filter((s) => s.role !== "global_admin").map((s) => <option key={s.id} value={`user:${s.id}`}>{s.name}</option>)}
          </Select>
        )}
      </Field>
    </div>
  );
}

/* ---------- Seleção múltipla em chips ---------- */
function ChipPicker({ label, empty, options, value, onChange }: {
  label: string; empty: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void;
}) {
  const rest = options.filter((o) => !value.includes(o.value));
  return (
    <div className="chippick">
      <span className="chippick__label">{label}</span>
      <div className="chippick__row">
        {value.length === 0 && <span className="chippick__empty">{empty}</span>}
        {value.map((v) => (
          <span key={v} className="step-chip">
            <span className="step-chip__name">{options.find((o) => o.value === v)?.label ?? v}</span>
            <button type="button" aria-label={`Remover ${options.find((o) => o.value === v)?.label ?? v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {rest.length > 0 && (
          <Select aria-label={`Adicionar ${label.toLowerCase()}`} className="chippick__add" value=""
            onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}>
            <option value="">+ Adicionar</option>
            {rest.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        )}
      </div>
    </div>
  );
}
