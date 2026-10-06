import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { Link, useNavigate, useParams, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, FilterBar, Input, LoadError, MetricCard, ProgressBar, Segmented, Select,
  Skeleton, StatusBadge, Tabs,
} from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { ProjectDetail, ProjectSchedule, ScheduleTask, ScheduleTrack, StaffMember, TaskAlert } from "@/types/domain";
import { alertPhrase, cx, formatDate, initials, plural, TASK_STATUS_TONE } from "@/utils/format";
import { TaskDrawer } from "./TaskDrawer";
import { AddTaskDrawer } from "./AddTaskDrawer";
import {
  displayStatus, durationText, forecastOf, isBlocked, isClosed, isOverdue, isWaitingClient, matchesFilters, progressOf,
  QUICK_FILTERS, serviceName, sortTracks, stepFilterKey, todayISO, TRACK_STATUS_LABEL, TRACK_STATUS_TONE,
  type QuickFilter, type ScheduleFilters,
} from "./model";

type View = "overview" | "tracks" | "list";
const VIEW_KEY = "yc-schedule-view";

/* ==========================================================================
   Cronograma do projeto
   ========================================================================== */
export function ProjectSchedulePage() {
  const { id = "" } = useParams();
  const { permissions } = useAuth();
  const navigate = useNavigate();
  const taskParam = useSearchParam("etapa");
  const project = useAsync(() => api.getProject(id), [id]);
  const sched = useAsync(() => api.getProjectSchedule(id), [id]);
  const deliveryTenant = project.data?.delivery_tenant_id ?? null;
  const staff = useAsync(() => (deliveryTenant ? api.listStaff(deliveryTenant) : Promise.resolve([] as StaffMember[])), [deliveryTenant]);

  const [view, setViewState] = useState<View>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as View) || "tracks"; } catch { return "tracks"; }
  });
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* sem armazenamento */ } };
  const [filters, setFilters] = useState<ScheduleFilters>({ quick: "all", service: "", responsible: "", step: "", showDone: true });
  const [mode, setMode] = useState<"view" | "manage">("view");
  const [selected, setSelected] = useState<string | null>(taskParam);
  const [addTrack, setAddTrack] = useState<string | null>(null);
  useEffect(() => { if (taskParam) setSelected(taskParam); }, [taskParam]);

  const p = project.data;
  useDocumentTitle(p ? `Cronograma · ${p.name}` : "Cronograma");
  const isGlobal = permissions?.role === "global_admin";
  const canManage = !!p && (isGlobal || (!!permissions?.is_manager && permissions.tenant_id === p.delivery_tenant_id));
  const me = permissions?.profile_id ?? null;

  const reload = () => { void sched.reload(); };

  if (project.error) return <div className="page"><LoadError message={project.error} onRetry={project.reload} /></div>;
  if (project.loading && !p) return <div className="page"><Skeleton width={280} height={28} /><Skeleton height={96} radius={16} /><Skeleton height={320} radius={16} /></div>;
  if (!p) {
    return <div className="page"><EmptyState icon="folder" title="Projeto não encontrado." text="Ele pode não existir ou não estar disponível para o seu acesso."
      action={<Link to="/projetos" className="btn btn--secondary btn--sm">Ver projetos</Link>} /></div>;
  }

  const s = sched.data;
  const notStarted = p.status === "awaiting_allocation" || p.status === "awaiting_team_assignment";
  const selectedTask = s?.tasks.find((t) => t.id === selected) ?? null;

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Você está em">
        <Link to="/projetos">Projetos</Link><Icon name="chevronRight" size={14} />
        <Link to={`/projetos/${p.id}`}>{p.code ?? p.name}</Link><Icon name="chevronRight" size={14} /><span>Cronograma</span>
      </nav>
      <PageHead title={p.name}
        subtitle={<>{p.client?.name ?? "—"} <span className="sep" aria-hidden="true" /> Cronograma por serviço, em dias úteis</>}
        actions={canManage && s && s.tasks.length > 0 ? (
          <Segmented<"view" | "manage"> label="Modo do cronograma" value={mode} onChange={setMode}
            options={[{ value: "view", label: "Visualização" }, { value: "manage", label: "Modo gestão" }]} />
        ) : undefined}
      />

      {notStarted ? (
        <Card><EmptyState icon="calendar" title="O cronograma é gerado quando a equipe for confirmada."
          text="Assim que o líder confirmar a equipe, cada serviço contratado ganha sua trilha a partir dos templates YouCon."
          action={<Link to={`/projetos/${p.id}`} className="btn btn--secondary btn--sm">Ver projeto</Link>} /></Card>
      ) : sched.error ? <LoadError message={sched.error} onRetry={sched.reload} /> :
        !s ? <><Skeleton height={88} radius={16} /><Skeleton height={280} radius={16} /></> : (
        <>
          <Attention project={p} schedule={s} canManage={canManage} onChanged={() => { reload(); void project.reload(); }} />
          {s.tracks.length === 0 ? (
            <Card><EmptyState icon="calendar" title="Cronograma ainda não gerado."
              text={canManage ? "Gere o cronograma a partir dos serviços contratados." : "O líder do projeto gera o cronograma."}
              action={canManage ? <GenerateButton projectId={p.id} onDone={reload} label="Gerar cronograma" /> : undefined} /></Card>
          ) : (
            <>
              <Summary schedule={s} />
              <div className="sched-bar">
                <Tabs<View> label="Visualização do cronograma" value={view} onChange={setView} tabs={[
                  { value: "overview", label: "Visão geral" },
                  { value: "tracks", label: "Trilhas" },
                  { value: "list", label: "Lista" },
                ]} />
                <span className="sched-bar__soon" title="Gantt interativo chega na Etapa 3.1"><Icon name="chart" size={14} /> Gantt <Badge tag>Etapa 3.1</Badge></span>
              </div>

              {view !== "overview" && (
                <Filters filters={filters} setFilters={setFilters} tracks={s.tracks} tasks={s.tasks} staff={staff.data ?? []} />
              )}

              {view === "overview" && <Overview schedule={s} staff={staff.data ?? []} onOpen={setSelected}
                onFilter={(q) => { setFilters((f) => ({ ...f, quick: q })); setView("list"); }} />}
              {view === "tracks" && <TracksView schedule={s} staff={staff.data ?? []} filters={filters} me={me} onOpen={setSelected}
                onAdd={canManage && mode === "manage" ? setAddTrack : undefined} />}
              {view === "list" && <ListView schedule={s} staff={staff.data ?? []} filters={filters} me={me} onOpen={setSelected} />}
            </>
          )}
        </>
      )}

      {s && addTrack && (
        <AddTaskDrawer trackId={addTrack} schedule={s} staff={staff.data ?? []} onClose={() => setAddTrack(null)}
          onSaved={(tid) => { setAddTrack(null); reload(); setSelected(tid); }} />
      )}
      {s && (
        <TaskDrawer task={selectedTask} schedule={s} staff={staff.data ?? []} me={me} canManage={canManage}
          managementMode={mode === "manage"} onChanged={reload} onOpenTask={setSelected}
          onClose={() => { setSelected(null); if (taskParam) navigate(`/projetos/${p.id}/cronograma`, { replace: true }); }} />
      )}
    </div>
  );
}

function GenerateButton({ projectId, onDone, label }: { projectId: string; onDone: () => void; label: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button size="sm" loading={busy} onClick={async () => {
      setBusy(true);
      try {
        const r = await api.generateSchedule(projectId);
        toast(r.tasks_created ? `${plural(r.tasks_created, "etapa criada", "etapas criadas")}.` : "Nada novo para gerar: os serviços pendentes continuam sem cronograma padrão.");
        onDone();
      } catch (e) { toast((e as Error).message, "error"); } finally { setBusy(false); }
    }}>{label}</Button>
  );
}

/* ---------- Pendências do cronograma (área, sem template, serviço novo) ---------- */
function Attention({ project, schedule, canManage, onChanged }: {
  project: ProjectDetail; schedule: ProjectSchedule; canManage: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const awaitingArea = schedule.tracks.filter((t) => t.status === "awaiting_area");
  const noTemplate = schedule.tracks.filter((t) => t.status === "no_template");
  const pending = project.services.filter((x) => x.active && x.status === "pending_review");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  if (!awaitingArea.length && !noTemplate.length && !pending.length) return null;

  return (
    <div className="stack">
      {pending.length > 0 && (
        <Alert tone="warning" title={pending.length === 1 ? "Novo serviço aguardando revisão" : `${pending.length} novos serviços aguardando revisão`}>
          <span className="att-list">
            {pending.map((x) => (
              <span key={x.id} className="att-item">
                <strong>{x.service?.name}</strong>
                {canManage && (
                  <Button size="sm" variant="secondary" loading={busy === x.id} onClick={async () => {
                    setBusy(x.id);
                    try { await api.activateProjectService(x.id); toast("Serviço incluído no cronograma. O restante foi preservado."); onChanged(); }
                    catch (e) { toast((e as Error).message, "error"); } finally { setBusy(null); }
                  }}>Incluir no cronograma</Button>
                )}
              </span>
            ))}
          </span>
          {!canManage && " O líder do projeto revisa e inclui no cronograma."}
        </Alert>
      )}
      {awaitingArea.length > 0 && (
        <Alert tone="warning" title="Área necessária para definir cronograma.">
          {awaitingArea.map(serviceName).join(", ")} {awaitingArea.length === 1 ? "tem" : "têm"} prazos diferentes conforme a área do projeto.
          {canManage ? (
            <form className="att-form" onSubmit={async (e) => {
              e.preventDefault();
              const v = Number(area.replace(",", "."));
              if (!v || v <= 0) { toast("Informe a área em m².", "error"); return; }
              setBusy("area");
              try { await api.setProjectArea(project.id, v); toast("Área registrada e cronograma definido."); setArea(""); onChanged(); }
              catch (err) { toast((err as Error).message, "error"); } finally { setBusy(null); }
            }}>
              <Input aria-label="Área do projeto em m²" inputMode="decimal" placeholder="Área em m²" value={area} onChange={(e) => setArea(e.target.value)} />
              <Button type="submit" size="sm" loading={busy === "area"}>Confirmar área</Button>
            </form>
          ) : " Peça ao líder do projeto para informar a área."}
        </Alert>
      )}
      {noTemplate.length > 0 && (
        <Alert tone="info" title="Sem cronograma padrão"
          action={canManage ? <GenerateButton projectId={project.id} onDone={onChanged} label="Tentar novamente" /> : undefined}>
          {noTemplate.map((t) => `${serviceName(t)}${t.status_note && t.status_note !== "Sem cronograma padrão" ? ` (${t.status_note})` : ""}`).join(", ")}.
          {" "}A YouCon ainda não definiu os prazos {noTemplate.length === 1 ? "deste serviço" : "destes serviços"}; nada foi inventado.
        </Alert>
      )}
    </div>
  );
}

/* ---------- Resumo ---------- */
function Summary({ schedule }: { schedule: ProjectSchedule }) {
  const pct = progressOf(schedule.tasks);
  const fc = forecastOf(schedule.tracks, schedule.tasks);
  return (
    <div className="sched-summary">
      <div className="sched-summary__progress">
        <span className="label">Progresso geral</span>
        <span className="sched-summary__pct num">{pct}%</span>
        <ProgressBar value={pct} label="Progresso geral do cronograma" />
      </div>
      <div>
        <span className="label">Previsão de conclusão</span>
        <span className="sched-summary__date num">{fc.date ? formatDate(fc.date, true) : "A definir"}</span>
        {fc.partial && <span className="subtext">Parcial: há etapas ou serviços sem prazo definido</span>}
      </div>
      <div>
        <span className="label">Serviços</span>
        <span className="sched-summary__date num">{schedule.tracks.length}</span>
      </div>
    </div>
  );
}

/* ---------- Filtros ---------- */
function Filters({ filters, setFilters, tracks, tasks, staff }: {
  filters: ScheduleFilters; setFilters: (f: ScheduleFilters) => void; tracks: ScheduleTrack[]; tasks: ScheduleTask[]; staff: StaffMember[];
}) {
  const active = filters.quick !== "all" || !!filters.service || !!filters.responsible || !!filters.step;
  // Etapas do projeto (do serviço escolhido, se houver), sem repetir nomes, na ordem do cronograma.
  const steps = useMemo(() => {
    const seen = new Map<string, string>();
    tasks.filter((t) => t.status !== "cancelled" && (!filters.service || t.schedule_track_id === filters.service))
      .sort((a, b) => (a.planned_start_date ?? "9999").localeCompare(b.planned_start_date ?? "9999") || a.sequence - b.sequence)
      .forEach((t) => { const k = stepFilterKey(t.name); if (!seen.has(k)) seen.set(k, t.name); });
    return [...seen.entries()];
  }, [tasks, filters.service]);
  const changeService = (service: string) => {
    const keepStep = !filters.step || tasks.some((t) => (!service || t.schedule_track_id === service) && stepFilterKey(t.name) === filters.step);
    setFilters({ ...filters, service, step: keepStep ? filters.step : "" });
  };
  return (
    <FilterBar active={active} onClear={() => setFilters({ ...filters, quick: "all", service: "", responsible: "", step: "" })}>
      <div className="chips" role="group" aria-label="Filtro rápido">
        {QUICK_FILTERS.map((q) => (
          <button key={q.value} type="button" className="chip" aria-pressed={filters.quick === q.value}
            onClick={() => setFilters({ ...filters, quick: q.value })}>{q.label}</button>
        ))}
      </div>
      <Select aria-label="Serviço" value={filters.service} onChange={(e) => changeService(e.target.value)}>
        <option value="">Todos os serviços</option>
        {sortTracks(tracks).map((t) => <option key={t.id} value={t.id}>{serviceName(t)}</option>)}
      </Select>
      <Select aria-label="Etapa" value={filters.step} onChange={(e) => setFilters({ ...filters, step: e.target.value })}>
        <option value="">Todas as etapas</option>
        {steps.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
      </Select>
      <Select aria-label="Responsável" value={filters.responsible} onChange={(e) => setFilters({ ...filters, responsible: e.target.value })}>
        <option value="">Todos os responsáveis</option>
        <option value="none">Sem responsável</option>
        {staff.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </Select>
    </FilterBar>
  );
}

/* ---------- Visão geral ---------- */
function Overview({ schedule, staff, onOpen, onFilter }: {
  schedule: ProjectSchedule; staff: StaffMember[]; onOpen: (id: string) => void; onFilter: (q: QuickFilter) => void;
}) {
  const today = todayISO();
  const t = schedule.tasks.filter((x) => x.status !== "cancelled");
  const done = t.filter((x) => x.status === "completed").length;
  const doing = t.filter((x) => x.actual_start_date && !isClosed(x)).length;
  const overdue = t.filter((x) => isOverdue(x, today)).length;
  const blocked = t.filter(isBlocked).length;
  const waiting = t.filter(isWaitingClient).length;
  const next = t.filter((x) => !isClosed(x) && x.planned_end_date)
    .sort((a, b) => a.planned_end_date!.localeCompare(b.planned_end_date!)).slice(0, 6);
  const tracks = sortTracks(schedule.tracks);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="metrics">
        <MetricCard label="Concluídas" value={`${done}/${t.length}`} tone="quiet" />
        <MetricCard label="Em andamento" value={doing} tone="brand" />
        <MetricCard label="Atrasadas" value={overdue} tone={overdue ? "danger" : "quiet"} onClick={overdue ? () => onFilter("overdue") : undefined} />
        <MetricCard label="Bloqueadas" value={blocked} tone={blocked ? "warning" : "quiet"} onClick={blocked ? () => onFilter("blocked") : undefined} />
        <MetricCard label="Aguardando cliente" value={waiting} tone={waiting ? "warning" : "quiet"} onClick={waiting ? () => onFilter("waiting_client") : undefined} />
      </div>
      <div className="detail-grid">
        <Card title="Serviços" count={tracks.length}>
          <ul className="svc-progress">
            {tracks.map((tr) => {
              const tt = schedule.tasks.filter((x) => x.schedule_track_id === tr.id);
              const pct = progressOf(tt);
              const late = tt.some((x) => isOverdue(x, today));
              return (
                <li key={tr.id}>
                  <div className="row-between">
                    <span className="svc-progress__name truncate">{serviceName(tr)}</span>
                    <Badge tone={late ? "danger" : TRACK_STATUS_TONE[tr.status]} dot>{late ? "Com atraso" : TRACK_STATUS_LABEL[tr.status]}</Badge>
                  </div>
                  {tt.length > 0 ? (
                    <>
                      <ProgressBar value={pct} label={`Progresso de ${serviceName(tr)}`} tone={late ? "danger" : undefined} thin />
                      <span className="svc-progress__meta num">
                        {pct}% · {formatDate(tr.planned_start_date)} – {tr.planned_end_date ? formatDate(tr.planned_end_date, true) : "término a definir"}
                      </span>
                    </>
                  ) : <span className="svc-progress__meta">{tr.status_note ?? "Sem etapas"}</span>}
                </li>
              );
            })}
          </ul>
        </Card>
        <Card title="Próximas entregas" flush>
          {next.length === 0 ? <EmptyState compact icon="checkCircle" title="Nenhuma entrega com prazo definido." /> : (
            <ul className="tasklist">{next.map((x) => <TaskRow key={x.id} task={x} schedule={schedule} staff={staff} onOpen={onOpen} />)}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function TaskRow({ task, schedule, staff, onOpen }: { task: ScheduleTask; schedule: ProjectSchedule; staff: StaffMember[]; onOpen: (id: string) => void }) {
  const st = displayStatus(task);
  const who = staff.find((m) => m.id === task.responsible_user_id);
  return (
    <li>
      <button type="button" className="task task--btn" onClick={() => onOpen(task.id)}>
        <span className={cx("task__dot", `tone-${TASK_STATUS_TONE[st]}`)} aria-hidden="true" />
        <span className="task__main">
          <span className="task__name truncate">{task.name}</span>
          <span className="task__meta truncate">{serviceName(schedule.tracks.find((t) => t.id === task.schedule_track_id))} · {who?.name ?? <em className="task__nobody">Sem responsável</em>}</span>
        </span>
        <span className="task__side"><StatusBadge status={st} /><span className="task__date num">{formatDate(task.planned_end_date)}</span></span>
      </button>
    </li>
  );
}

/* ---------- Trilhas ---------- */
function TracksView({ schedule, staff, filters, me, onOpen, onAdd }: {
  schedule: ProjectSchedule; staff: StaffMember[]; filters: ScheduleFilters; me: string | null; onOpen: (id: string) => void;
  onAdd?: (trackId: string) => void;
}) {
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const today = todayISO();
  const tracks = sortTracks(schedule.tracks).filter((tr) => !filters.service || tr.id === filters.service);
  const filtered = filters.quick !== "all" || !!filters.responsible || !!filters.step;
  const visible = tracks.map((tr) => ({ tr, tasks: schedule.tasks.filter((t) => t.schedule_track_id === tr.id && matchesFilters(t, filters, me, today)) }))
    .filter((x) => !filtered || x.tasks.length > 0);

  if (visible.length === 0) return <Card><EmptyState icon="search" title="Nenhuma etapa com estes filtros." /></Card>;
  const allCollapsed = visible.every((x) => collapsed[x.tr.id]);

  return (
    <div className="stack">
      {visible.length > 1 && (
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="ghost" size="sm" icon={allCollapsed ? "chevronDown" : "chevronRight"}
            onClick={() => setCollapsed(Object.fromEntries(visible.map((x) => [x.tr.id, !allCollapsed])))}>
            {allCollapsed ? "Expandir todas" : "Recolher todas"}
          </Button>
        </div>
      )}
      {visible.map(({ tr, tasks }) => {
        const all = schedule.tasks.filter((t) => t.schedule_track_id === tr.id);
        const pct = progressOf(all);
        const late = all.filter((t) => isOverdue(t, today)).length;
        const isCollapsed = !!collapsed[tr.id];
        return (
          <section key={tr.id} className="track">
            <button type="button" className="track__head" aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((c) => ({ ...c, [tr.id]: !c[tr.id] }))}>
              <Icon name={isCollapsed ? "chevronRight" : "chevronDown"} size={16} />
              <span className="track__title">
                <span className="track__name">{serviceName(tr)}</span>
                <span className="track__meta">
                  {tr.project_service?.service?.family?.name}
                  {tr.template ? ` · padrão v${tr.template.version}` : ""}
                  {all.length ? ` · ${formatDate(tr.planned_start_date)} – ${tr.planned_end_date ? formatDate(tr.planned_end_date, true) : "a definir"}` : ""}
                </span>
              </span>
              <span className="track__side">
                {late > 0 && <Badge tone="danger">{plural(late, "atrasada", "atrasadas")}</Badge>}
                {all.length > 0 ? (
                  <span className="track__pct">
                    <span className="num">{pct}%</span>
                    <ProgressBar value={pct} label={`Progresso de ${serviceName(tr)}`} thin />
                  </span>
                ) : <Badge tone={TRACK_STATUS_TONE[tr.status]}>{TRACK_STATUS_LABEL[tr.status]}</Badge>}
              </span>
            </button>
            {!isCollapsed && (
              <>
                {all.length === 0 ? <p className="track__empty subtext">{tr.status_note ?? "Sem etapas."}</p> : (
                  <ol className={cx("chain", mobile && "chain--vertical")}>
                    {tasks.map((t, i) => (
                      <li key={t.id} className="chain__item">
                        {i > 0 && !mobile && <Icon name="chevronRight" size={14} className="chain__arrow" />}
                        <StepCard task={t} staff={staff} onOpen={onOpen} />
                      </li>
                    ))}
                  </ol>
                )}
                {onAdd && (
                  <div className="track__add"><Button variant="outline" size="sm" icon="plus" onClick={() => onAdd(tr.id)}>Adicionar etapa</Button></div>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StepCard({ task, staff, onOpen }: { task: ScheduleTask; staff: StaffMember[]; onOpen: (id: string) => void }) {
  const st = displayStatus(task);
  const who = staff.find((m) => m.id === task.responsible_user_id);
  const tone = TASK_STATUS_TONE[st];
  const skipped = task.status === "cancelled";
  return (
    <button type="button" className={cx("step", `step--${tone}`, skipped && "step--skipped")} onClick={() => onOpen(task.id)}
      aria-label={`${task.name}: ${st === "overdue" ? "atrasada" : ""}`.trim()}>
      <span className="step__name">{task.name}</span>
      <span className="step__dates num">
        {skipped ? (task.auto_skipped ? "Dispensada" : "Cancelada")
          : task.planned_start_date ? `${formatDate(task.planned_start_date)} – ${task.planned_end_date ? formatDate(task.planned_end_date) : "…"}` : durationText(task)}
      </span>
      <span className="step__foot">
        {!skipped && (who
          ? <span className="step__who" title={who.name}><span className="step__avatar" aria-hidden="true">{initials(who.name)}</span><span className="truncate">{who.name.split(" ")[0]}</span></span>
          : <span className="step__who step__who--none">Sem responsável</span>)}
        {!skipped && <StatusBadge status={st} />}
      </span>
    </button>
  );
}

/* ---------- Lista ---------- */
function ListView({ schedule, staff, filters, me, onOpen }: {
  schedule: ProjectSchedule; staff: StaffMember[]; filters: ScheduleFilters; me: string | null; onOpen: (id: string) => void;
}) {
  const mobile = useIsMobile();
  const today = todayISO();
  const order = new Map(sortTracks(schedule.tracks).map((t, i) => [t.id, i]));
  const rows = schedule.tasks.filter((t) => matchesFilters(t, filters, me, today))
    .sort((a, b) => (order.get(a.schedule_track_id)! - order.get(b.schedule_track_id)!) || a.sequence - b.sequence);
  const nameById = new Map(schedule.tasks.map((t) => [t.id, t.name]));
  const predsOf = (id: string) => schedule.dependencies.filter((d) => d.task_id === id).map((d) => nameById.get(d.depends_on_task_id)).filter(Boolean);

  if (rows.length === 0) return <Card><EmptyState icon="search" title="Nenhuma etapa com estes filtros." /></Card>;
  if (mobile) {
    return <Card flush><ul className="tasklist">{rows.map((t) => <TaskRow key={t.id} task={t} schedule={schedule} staff={staff} onOpen={onOpen} />)}</ul></Card>;
  }
  return (
    <Card flush>
      <div className="table-scroll">
        <table className="list">
          <thead><tr>
            <th scope="col">Etapa</th><th scope="col">Serviço</th><th scope="col">Responsável</th><th scope="col">Início</th>
            <th scope="col">Prazo</th><th scope="col">Término</th><th scope="col">Status</th><th scope="col">Dependência</th>
            <th scope="col"><span className="sr-only">Ações</span></th>
          </tr></thead>
          <tbody>
            {rows.map((t) => {
              const who = staff.find((m) => m.id === t.responsible_user_id);
              const preds = predsOf(t.id);
              return (
                <tr key={t.id} className="is-clickable" onClick={() => onOpen(t.id)}>
                  <td><span className="ident__name">{t.name}</span></td>
                  <td className="muted">{serviceName(schedule.tracks.find((x) => x.id === t.schedule_track_id))}</td>
                  <td>{who ? <span className="row"><Avatar name={who.name} size="sm" /><span className="truncate">{who.name}</span></span> : <span className="text-warning">—</span>}</td>
                  <td className="num">{formatDate(t.planned_start_date)}</td>
                  <td className="muted">{durationText(t)}</td>
                  <td className={cx("num", isOverdue(t, today) && "text-danger")}>{t.actual_end_date ? formatDate(t.actual_end_date) : formatDate(t.planned_end_date)}</td>
                  <td><StatusBadge status={displayStatus(t, today)} /></td>
                  <td className="muted truncate" style={{ maxWidth: 200 }}>{preds.length ? preds.join(", ") : "—"}</td>
                  <td><Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}>Abrir</Button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ==========================================================================
   Cronograma (todas as etapas abertas que a pessoa pode ver)
   ========================================================================== */
type MyTab = "mine" | "all";
type MyFilter = "all" | "overdue" | "week" | "blocked" | "waiting_client" | "unassigned";

export function MySchedulePage() {
  useDocumentTitle("Cronograma");
  const { permissions } = useAuth();
  const navigate = useNavigate();
  const initial = useSearchParam("filtro") as MyFilter | null;
  const manager = !!permissions?.is_manager;
  const me = permissions?.profile_id ?? null;
  const { data, error, loading, reload } = useAsync(() => api.openTaskAlerts(), []);
  const people = useAsync(() => (manager ? api.listProfiles() : Promise.resolve([])), [manager]);
  const [tab, setTab] = useState<MyTab>(manager ? "all" : "mine");
  const [filter, setFilter] = useState<MyFilter>(initial ?? "all");

  const all = data ?? [];
  const scoped = tab === "mine" ? all.filter((a) => a.responsible_user_id === me) : all;
  const test = (a: TaskAlert, f: MyFilter) => {
    switch (f) {
      case "overdue": return a.is_overdue;
      case "week": return !a.is_overdue && a.due_in_days != null && a.due_in_days >= 0 && a.due_in_days <= 7;
      case "blocked": return a.is_blocked;
      case "waiting_client": return a.is_waiting_client;
      case "unassigned": return a.is_unassigned;
      default: return true;
    }
  };
  const list = scoped.filter((a) => test(a, filter));
  const counts = useMemo(() => Object.fromEntries((["overdue", "week", "blocked", "waiting_client", "unassigned"] as MyFilter[])
    .map((f) => [f, scoped.filter((a) => test(a, f)).length])) as Record<MyFilter, number>, [scoped]);
  const nameOf = (id: string | null) => (people.data ?? []).find((p) => p.id === id)?.name;

  const filters: { value: MyFilter; label: string }[] = [
    { value: "all", label: "Todas" },
    { value: "overdue", label: `Atrasadas${counts.overdue ? ` · ${counts.overdue}` : ""}` },
    { value: "week", label: `Próximos 7 dias${counts.week ? ` · ${counts.week}` : ""}` },
    { value: "blocked", label: `Bloqueadas${counts.blocked ? ` · ${counts.blocked}` : ""}` },
    { value: "waiting_client", label: `Aguardando cliente${counts.waiting_client ? ` · ${counts.waiting_client}` : ""}` },
    ...(manager ? [{ value: "unassigned" as MyFilter, label: `Sem responsável${counts.unassigned ? ` · ${counts.unassigned}` : ""}` }] : []),
  ];

  return (
    <div className="page">
      <PageHead title="Cronograma" subtitle={manager ? "Etapas abertas dos projetos da sua unidade. Abra uma etapa para ver o cronograma completo do projeto." : "Suas etapas, prazos e pendências em todos os projetos."} />
      {manager && (
        <Tabs<MyTab> label="Escopo" value={tab} onChange={setTab} tabs={[
          { value: "all", label: "Todas as etapas", count: all.length },
          { value: "mine", label: "Minhas etapas", count: all.filter((a) => a.responsible_user_id === me).length },
        ]} />
      )}
      <div className="chips" role="group" aria-label="Filtro rápido">
        {filters.map((f) => (
          <button key={f.value} type="button" className="chip" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</button>
        ))}
      </div>
      {error ? <LoadError message={error} onRetry={reload} /> : loading && !data ? <Skeleton height={280} radius={16} /> :
        list.length === 0 ? (
          <Card>
            {all.length === 0
              ? <EmptyState icon="calendar" title="Nenhuma etapa aberta." text="Quando um projeto iniciar, as etapas do cronograma aparecem aqui." />
              : <EmptyState icon="checkCircle" title={filter === "all" ? "Nenhuma etapa sob sua responsabilidade." : "Nada nesta situação."} text="Bom sinal." />}
          </Card>
        ) : (
          <Card flush>
            <ul className="tasklist">
              {list.map((a) => {
                const al = alertPhrase(a);
                return (
                  <li key={a.task_id}>
                    <button type="button" className="task task--btn" onClick={() => navigate(`/projetos/${a.project_id}/cronograma?etapa=${a.task_id}`)}>
                      <span className={cx("task__dot", `tone-${al.tone}`)} aria-hidden="true" />
                      <span className="task__main">
                        <span className="task__name truncate">{a.task_name}</span>
                        <span className="task__meta truncate">
                          {a.project_name} · {a.service_name}
                          {tab === "all" && <> · {a.responsible_user_id ? nameOf(a.responsible_user_id) ?? "Equipe" : <em className="task__nobody">Sem responsável</em>}</>}
                        </span>
                      </span>
                      <span className="task__side">{!al.text.startsWith("Prazo ") && <Badge tone={al.tone}>{al.text}</Badge>}<span className="task__date num">{formatDate(a.planned_end_date)}</span></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
    </div>
  );
}
