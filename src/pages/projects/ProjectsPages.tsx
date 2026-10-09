import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { Link, useNavigate, useParams, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import { ProjectApprovalsCard } from "@/pages/approvals/ProjectApprovals";
import { ProjectCsCard } from "@/pages/cs/CsPage";
import { ProjectDeliveriesCard } from "@/pages/deliveries/Deliveries";
import { ClientWaitsCard } from "@/pages/schedule/ClientWaits";
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, Field, FilterBar, Input, LoadError, SearchInput, Segmented, Select, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import { StepAssignPicker, stepKey } from "@/components/ui/StepAssignPicker";
import { ProjectBoard } from "./ProjectBoard";
import type { EmploymentType, LeadershipArea, ProjectDetail, ProjectListItem, ProjectStatus, StaffMember, StepOption, Tenant } from "@/types/domain";
import {
  ALLOCATION_METHOD_LABEL, CLIENT_TYPE_LABEL, EMPLOYMENT_LABEL, formatDate, formatDateTime, PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE, ROLE_LABEL, SERVICE_STATUS_LABEL,
} from "@/utils/format";

type TabKey = "pending" | "active" | "done" | "all";

/** Liderança da YouCon: um líder por área (pode ser a mesma pessoa nas três). */
const LEAD_AREAS: { area: LeadershipArea; role: string; label: string }[] = [
  { area: "architecture", role: "lead_architecture", label: "Arquitetura" },
  { area: "engineering", role: "lead_engineering", label: "Engenharia" },
  { area: "approval", role: "lead_approval", label: "Aprovação" },
];
const LEAD_ROLES = new Set(LEAD_AREAS.map((a) => a.role));

/* ==========================================================================
   Lista
   ========================================================================== */
export function ProjectsPage() {
  useDocumentTitle("Projetos");
  const { permissions } = useAuth();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const initialStatus = useSearchParam("status");
  const { data, error, loading, reload } = useAsync(() => api.listProjects(), []);
  const [tab, setTab] = useState<TabKey>(initialStatus === "in_progress" ? "active" : "pending");
  const [q, setQ] = useState("");
  const staff = !!permissions?.is_staff;
  const [view, setViewState] = useState<"board" | "list">(() => {
    if (initialStatus) return "list";
    try { return (localStorage.getItem("yc-projects-view") as "board" | "list") || "board"; } catch { return "board"; }
  });
  const setView = (v: "board" | "list") => { setViewState(v); try { localStorage.setItem("yc-projects-view", v); } catch { /* sem armazenamento */ } };
  const [situation, setSituation] = useState<"" | TabKey>("");
  const showBoard = staff && view === "board";

  const all = data ?? [];
  const isPending = (p: ProjectListItem) => p.status === "awaiting_allocation" || p.status === "awaiting_team_assignment";
  const counts = {
    pending: all.filter(isPending).length,
    active: all.filter((p) => p.status === "in_progress" || p.status === "on_hold").length,
    done: all.filter((p) => p.status === "completed" || p.status === "cancelled").length,
    all: all.length,
  };
  const scope = showBoard ? (situation || "all") : tab;
  const list = all.filter((p) => {
    if (scope === "pending" && !isPending(p)) return false;
    if (scope === "active" && !(p.status === "in_progress" || p.status === "on_hold")) return false;
    if (scope === "done" && !(p.status === "completed" || p.status === "cancelled")) return false;
    if (q) {
      const s = q.toLowerCase();
      return [p.name, p.code, p.client?.name, p.city].some((v) => v?.toLowerCase().includes(s));
    }
    return true;
  });

  return (
    <div className="page">
      <PageHead
        title="Projetos"
        subtitle={permissions?.is_manager
          ? "Projetos vendidos ou executados pela sua unidade. Novos projetos chegam pela Central de Entrada."
          : "Projetos em que você está na equipe."}
        actions={staff ? (
          <Segmented<"board" | "list"> label="Forma de exibição" value={view} onChange={setView}
            options={[{ value: "board", label: "Quadro" }, { value: "list", label: "Lista" }]} />
        ) : undefined}
      />
      {!showBoard && (
        <Tabs<TabKey> label="Situação dos projetos" value={tab} onChange={setTab} tabs={[
          { value: "pending", label: "Aguardando ação", count: counts.pending },
          { value: "active", label: "Em andamento", count: counts.active },
          { value: "done", label: "Encerrados", count: counts.done },
          { value: "all", label: "Todos", count: counts.all },
        ]} />
      )}
      <FilterBar active={!!q || (showBoard && !!situation)} onClear={() => { setQ(""); setSituation(""); }}>
        <SearchInput placeholder="Buscar por projeto, código, cliente ou cidade" aria-label="Buscar projetos" value={q} onChange={(e) => setQ(e.target.value)} />
        {showBoard && (
          <Select aria-label="Situação" value={situation} onChange={(e) => setSituation(e.target.value as "" | TabKey)}>
            <option value="">Todas as situações · {counts.all}</option>
            <option value="pending">Aguardando ação · {counts.pending}</option>
            <option value="active">Em andamento · {counts.active}</option>
            <option value="done">Encerrados · {counts.done}</option>
          </Select>
        )}
      </FilterBar>

      {showBoard && !error && data ? <ProjectBoard projects={list} canEdit={!!permissions?.is_manager} /> :
       error ? <LoadError message={error} onRetry={reload} /> :
       loading && !data ? (
        <div className="pgrid">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={150} radius={16} />)}</div>
      ) : list.length === 0 ? (
        <Card>
          {all.length === 0 ? (
            <EmptyState icon="folder" title="Nenhum projeto ainda."
              text={permissions?.is_manager
                ? "Quando uma venda for fechada no CRM, o projeto aparece aqui para distribuição e definição da equipe."
                : "Quando você for incluído na equipe de um projeto, ele aparecerá aqui."} />
          ) : tab === "pending" && !q ? (
            <EmptyState icon="checkCircle" title="Nenhum projeto aguardando ação."
              text="Projetos sem unidade ou sem equipe definida aparecem aqui." />
          ) : (
            <EmptyState icon="search" title="Nenhum projeto encontrado." />
          )}
        </Card>
      ) : (
        <div className={mobile ? "stack" : "pgrid"}>
          {list.map((p) => (
            <button key={p.id} type="button" className="ptile" onClick={() => navigate(`/projetos/${p.id}`)}>
              <span className="row-between">
                <span className="ptile__code num">{p.code ?? "—"}</span>
                <span className="badge-row">
                  <span className="badge badge--tag badge--outline">{CLIENT_TYPE_LABEL[p.client_type]}</span>
                  <StatusPill status={p.status} />
                </span>
              </span>
              <span className="ptile__name truncate">{p.name}</span>
              <span className="ptile__client truncate">{p.client?.name ?? "—"}{p.city ? ` · ${p.city}${p.state ? `/${p.state}` : ""}` : ""}</span>
              <span className="ptile__services truncate">
                {p.services.filter((s) => s.active).map((s) => s.service?.name).filter(Boolean).join(" · ") || "Sem serviços"}
              </span>
              <span className="ptile__foot">
                <span><Icon name="building" size={14} /> {p.delivery?.name ?? (p.delivery_tenant_id ? "Outra unidade" : "Sem unidade")}</span>
                <span className="num"><Icon name="calendar" size={14} /> {formatDate(p.contracted_at)}</span>
                {p.services.some((s) => s.status === "pending_review" && s.active) && <Badge tone="warning">Serviço novo</Badge>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_STATUS_TONE[status]} dot>{PROJECT_STATUS_LABEL[status]}</Badge>;
}

/* ==========================================================================
   Detalhe
   ========================================================================== */
export function ProjectDetailPage() {
  const { id } = useParams();
  const { permissions, profile } = useAuth();
  const action = useSearchParam("acao");
  const navigate = useNavigate();
  const { data: p, error, loading, reload } = useAsync(() => api.getProject(id ?? ""), [id]);
  const [teamOpen, setTeamOpen] = useState(false);
  const [allocOpen, setAllocOpen] = useState(false);
  useDocumentTitle(p?.name ?? "Projeto");

  const isGlobal = permissions?.role === "global_admin";
  const canManage = !!p && (isGlobal || (!!permissions?.is_manager && permissions.tenant_id === p.delivery_tenant_id));
  const canDistribute = !!p && isGlobal && (p.status === "awaiting_allocation" || p.status === "awaiting_team_assignment");
  const canAssign = !!p && canManage && !!p.delivery_tenant_id && ["awaiting_team_assignment", "in_progress", "on_hold"].includes(p.status);

  useEffect(() => {
    if (!p) return;
    if (action === "equipe" && canAssign) setTeamOpen(true);
    if (action === "distribuir" && canDistribute) setAllocOpen(true);
  }, [p, action, canAssign, canDistribute]);

  if (error) return <div className="page"><LoadError message={error} onRetry={reload} /></div>;
  if (loading && !p) {
    return <div className="page"><Skeleton width={320} height={28} /><Skeleton height={120} radius={16} /><Skeleton height={240} radius={16} /></div>;
  }
  if (!p) {
    return (
      <div className="page">
        <EmptyState icon="folder" title="Projeto não encontrado."
          text="Ele pode não existir ou não estar disponível para o seu acesso."
          action={<Link to="/projetos" className="btn btn--secondary btn--sm">Ver projetos</Link>} />
      </div>
    );
  }

  const pendingServices = p.services.filter((s) => s.active && s.status === "pending_review");

  return (
    <div className="page">
      <nav className="crumbs" aria-label="Você está em">
        <Link to="/projetos">Projetos</Link><Icon name="chevronRight" size={14} /><span>{p.code ?? p.name}</span>
      </nav>
      <PageHead
        title={p.name}
        subtitle={<>{p.client?.name ?? "—"} <span className="sep" aria-hidden="true" /> {CLIENT_TYPE_LABEL[p.client_type]}
          {p.project_type ? <> <span className="sep" aria-hidden="true" /> {p.project_type}</> : null}</>}
        actions={
          <>
            {/* Nos estados "aguardando", a ação principal fica na faixa de alerta logo abaixo. */}
            {canDistribute && p.status !== "awaiting_allocation" && (
              <Button variant="outline" icon="building" onClick={() => setAllocOpen(true)}>Trocar unidade</Button>
            )}
            {canAssign && p.status !== "awaiting_team_assignment" && (
              <Button variant="outline" icon="userPlus" onClick={() => setTeamOpen(true)}>Editar equipe</Button>
            )}
            {["in_progress", "on_hold", "completed"].includes(p.status) && (
              <>
                <Link to={`/projetos/${p.id}/entregas`} className="btn btn--outline"><Icon name="layers" /> Entregas</Link>
                <Link to={`/projetos/${p.id}/cronograma`} className="btn btn--primary"><Icon name="calendar" /> Cronograma</Link>
              </>
            )}
          </>
        }
      />

      <ProjectStateBand p={p} canAssign={canAssign} canDistribute={canDistribute}
        onAssign={() => setTeamOpen(true)} onDistribute={() => setAllocOpen(true)} pendingServices={pendingServices.length} />

      <div className="detail-grid">
        <div className="stack" style={{ gap: 16 }}>
          {permissions?.is_staff && p.status === "in_progress" && <ClientWaitsCard projectId={p.id} />}
          <Card title="Serviços contratados" count={p.services.filter((s) => s.active).length}>
            <ul className="svc-list">
              {p.services.filter((s) => s.active).map((s) => (
                <li key={s.id}>
                  <span className="grow">
                    <span className="svc-list__name">{s.service?.name}</span>
                    <span className="svc-list__meta">{s.service?.family?.name} · contratado {formatDate(s.contracted_at, true)}</span>
                  </span>
                  <Badge tone={s.status === "pending_review" ? "warning" : s.status === "active" ? "success" : "neutral"}>
                    {SERVICE_STATUS_LABEL[s.status]}
                  </Badge>
                </li>
              ))}
            </ul>
            {(p.status === "in_progress" || p.status === "on_hold" || p.status === "completed")
              ? <div className="card__note"><Link to={`/projetos/${p.id}/cronograma`} className="btn btn--secondary btn--sm">Abrir cronograma</Link></div>
              : <p className="subtext card__note">O cronograma é gerado a partir dos padrões YouCon quando a equipe for confirmada.</p>}
          </Card>

          {permissions?.is_staff && ["in_progress", "on_hold", "completed"].includes(p.status) && <ProjectDeliveriesCard projectId={p.id} />}
          {permissions?.is_staff && ["in_progress", "on_hold", "completed"].includes(p.status) && <ProjectApprovalsCard projectId={p.id} />}
          {permissions?.is_staff && <ProjectCsCard projectId={p.id} />}

          <TeamCard project={p} canAssign={canAssign} staff={!!permissions?.is_staff} me={profile?.id ?? null} onEdit={() => setTeamOpen(true)} />
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Resumo">
            <dl className="kv">
              <div><dt>Código</dt><dd className="num">{p.code ?? "—"}</dd></div>
              <div><dt>Situação</dt><dd><StatusPill status={p.status} /></dd></div>
              <div><dt>Fechamento</dt><dd className="num">{formatDate(p.contracted_at, true)}</dd></div>
              {p.started_at && <div><dt>Início</dt><dd className="num">{formatDate(p.started_at, true)}</dd></div>}
              <div><dt>Local</dt><dd>{p.city ? `${p.city}${p.state ? `/${p.state}` : ""}` : "—"}</dd></div>
              <div><dt>Área</dt><dd className="num">{p.area_m2 != null ? `${String(p.area_m2).replace(".", ",")} m²` : "Não informada"}</dd></div>
              {p.external_id && <div><dt>Origem no CRM</dt><dd className="num">{p.external_source === "pipefy" ? "Pipefy" : "Manual"} #{p.external_id.slice(0, 14)}</dd></div>}
            </dl>
          </Card>

          <Card title="Unidades">
            <dl className="kv">
              <div><dt>Origem do lead</dt><dd>{p.origin?.name ?? (p.origin_tenant_id ? "Outra unidade" : "—")}</dd></div>
              <div><dt>Venda</dt><dd>{p.commercial?.name ?? "Outra unidade"}</dd></div>
              <div><dt>Execução</dt><dd>{p.delivery?.name ?? (p.delivery_tenant_id ? "Outra unidade" : <span className="text-warning">A definir</span>)}</dd></div>
            </dl>
          </Card>

          {p.client && (
            <Card title="Cliente">
              <dl className="kv">
                <div><dt>Nome</dt><dd>{p.client.name}</dd></div>
                {p.client.company_name && <div><dt>Empresa</dt><dd>{p.client.company_name}</dd></div>}
                <div><dt>E-mail</dt><dd className="truncate">{p.client.email ?? "—"}</dd></div>
                <div><dt>Telefone</dt><dd>{p.client.phone ?? "—"}</dd></div>
              </dl>
            </Card>
          )}

          {p.allocations.length > 0 && (
            <Card title="Histórico de distribuição">
              <ul className="history">
                {[...p.allocations].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((a) => (
                  <li key={a.id} className={a.allocation_status === "revoked" ? "is-muted" : undefined}>
                    <span className="history__what">
                      {a.allocation_status === "pending" ? "Aguardando distribuição"
                        : a.allocation_status === "revoked" ? `Substituída · ${a.delivery?.name ?? "—"}`
                        : `${a.delivery?.name ?? "Unidade"} · ${ALLOCATION_METHOD_LABEL[a.allocation_method] ?? a.allocation_method}`}
                    </span>
                    <span className="history__when num">{formatDateTime(a.allocated_at ?? a.created_at)}</span>
                    {a.notes && <span className="history__note">{a.notes}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {canAssign && (
        <TeamDrawer open={teamOpen} project={p}
          onClose={() => { setTeamOpen(false); if (action) navigate(`/projetos/${p.id}`, { replace: true }); }}
          onSaved={() => { setTeamOpen(false); void reload(); if (action) navigate(`/projetos/${p.id}`, { replace: true }); }} />
      )}
      {canDistribute && (
        <AllocateDrawer open={allocOpen} project={p}
          onClose={() => setAllocOpen(false)} onSaved={() => { setAllocOpen(false); void reload(); }} />
      )}
    </div>
  );
}

function ProjectStateBand({ p, canAssign, canDistribute, onAssign, onDistribute, pendingServices }: {
  p: ProjectDetail; canAssign: boolean; canDistribute: boolean; onAssign: () => void; onDistribute: () => void; pendingServices: number;
}) {
  if (p.status === "awaiting_allocation") {
    return (
      <Alert tone="warning" title="Aguardando distribuição"
        action={canDistribute ? <Button size="sm" onClick={onDistribute}>Distribuir</Button> : undefined}>
        A Franqueadora define qual unidade executa este projeto.
      </Alert>
    );
  }
  if (p.status === "awaiting_team_assignment") {
    return (
      <Alert tone="warning" title="Aguardando equipe"
        action={canAssign ? <Button size="sm" onClick={onAssign}>Revisar e atribuir equipe</Button> : undefined}>
        Defina os líderes de Arquitetura, Engenharia e Aprovação e os responsáveis por serviço. A confirmação inicia o projeto e libera o acesso da equipe e do cliente.
      </Alert>
    );
  }
  if (pendingServices > 0) {
    return (
      <Alert tone="info" title={pendingServices === 1 ? "Novo serviço contratado" : `${pendingServices} novos serviços contratados`}
        action={canAssign ? <Button size="sm" variant="outline" onClick={onAssign}>Revisar equipe</Button> : undefined}>
        Os serviços anteriores seguem preservados. Confira se a equipe cobre as novas disciplinas.
      </Alert>
    );
  }
  return null;
}

/* ==========================================================================
   Equipe: Líder + responsável direto por serviço + colaboradores indiretos
   ========================================================================== */
type ProjectService = ProjectDetail["services"][number];

function activeServices(project: ProjectDetail): ProjectService[] {
  return project.services.filter((s) => s.active && s.status !== "cancelled")
    .sort((a, b) => (a.service?.family?.sort_order ?? 99) - (b.service?.family?.sort_order ?? 99));
}

function TeamCard({ project, canAssign, staff, me }: { project: ProjectDetail; canAssign: boolean; staff: boolean; me: string | null; onEdit?: () => void }) {
  const stepOpts = useAsync(() => (staff && project.team.some((t) => t.active && t.project_role === "support") ? api.projectStepOptions(project.id) : Promise.resolve([] as StepOption[])),
    [staff, project]);
  const stepsOf = (userId: string) => (stepOpts.data ?? []).filter((o) => o.user_id === userId);
  const team = project.team.filter((t) => t.active && t.user);
  const leaders = LEAD_AREAS.map((a) => ({ ...a, user: team.find((t) => t.project_role === a.role)?.user ?? null }));
  const leaderIds = new Set(leaders.map((l) => l.user?.id).filter(Boolean));
  const services = activeServices(project);
  const directIds = new Set(services.map((s) => s.responsible_user_id).filter(Boolean));
  const indirect = team.filter((t) => t.project_role === "support" && t.user && !directIds.has(t.user.id) && !leaderIds.has(t.user.id));
  const empty = team.length === 0;
  const Person = ({ u }: { u: { id: string; name: string; avatar_url: string | null; employment_type: EmploymentType | null } }) => (
    <span className="ident">
      <Avatar name={u.name} src={u.avatar_url} size="sm" />
      <span className="ident__name truncate">{u.name}{u.id === me && <span className="muted"> (você)</span>}</span>
      {u.employment_type && <Badge tag outline>{EMPLOYMENT_LABEL[u.employment_type]}</Badge>}
    </span>
  );

  return (
    <Card title="Equipe" count={team.length ? new Set(team.map((t) => t.user!.id)).size : undefined}>
      {empty ? (
        <EmptyState compact icon="users" title="Equipe ainda não definida."
          text={canAssign ? "Defina os líderes de Arquitetura, Engenharia e Aprovação e o responsável direto de cada serviço para iniciar." : "O líder da unidade executora definirá a equipe."} />
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div>
            <p className="label team-list__group">Liderança</p>
            <ul className="team-list">
              {leaders.map((l) => (
                <li key={l.area}>
                  <span className="team-list__role team-list__svc">{l.label}</span>
                  {l.user ? <Person u={l.user} /> : <span className="text-warning">A definir</span>}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="label team-list__group">Responsáveis diretos · contato com o cliente</p>
            <ul className="team-list">
              {services.map((s) => (
                <li key={s.id}>
                  <span className="team-list__role team-list__svc">{s.service?.name}</span>
                  {s.responsible ? <Person u={s.responsible} /> : <span className="text-warning">Sem responsável</span>}
                </li>
              ))}
            </ul>
          </div>
          {indirect.length > 0 && (
            <div>
              <p className="label team-list__group">Colaboradores indiretos</p>
              <ul className="team-list">
                {indirect.map((t) => {
                  const mine = stepsOf(t.user!.id);
                  return (
                    <li key={t.id} className="team-list__indirect">
                      <Person u={t.user!} />
                      {mine.length > 0 ? (
                        <ul className="indirect__steps" aria-label={`Etapas de ${t.user!.name}`}>
                          {mine.map((o) => <li key={`${o.project_service_id}|${o.task_code}`} className="step-chip step-chip--ro"><span className="step-chip__name">{o.task_name}</span><span className="step-chip__svc">{o.service_name}</span></li>)}
                        </ul>
                      ) : <span className="subtext">Etapas definidas no cronograma</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function TeamDrawer({ open, project, onClose, onSaved }: {
  open: boolean; project: ProjectDetail; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const staff = useAsync(() => (open && project.delivery_tenant_id ? api.listStaff(project.delivery_tenant_id) : Promise.resolve([] as StaffMember[])),
    [open, project.delivery_tenant_id]);
  const services = useMemo(() => activeServices(project), [project]);
  const [leads, setLeads] = useState<Record<LeadershipArea, string>>({ architecture: "", engineering: "", approval: "" });
  const [byService, setByService] = useState<Record<string, string>>({});
  const steps = useAsync(() => (open ? api.projectStepOptions(project.id) : Promise.resolve([] as StepOption[])), [open, project.id]);
  const [indirect, setIndirect] = useState<{ user: string; steps: string[] }[]>([]);
  const [adding, setAdding] = useState("");
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const team = project.team.filter((t) => t.active && t.user);
    const legacyLead = team.find((t) => t.project_role === "project_lead")?.user?.id ?? "";
    setLeads(Object.fromEntries(LEAD_AREAS.map((a) => [a.area, team.find((t) => t.project_role === a.role)?.user?.id ?? legacyLead])) as Record<LeadershipArea, string>);
    // Responsável direto salvo; para projetos da Etapa 2, sugere quem tinha a função da família do serviço.
    const initial: Record<string, string> = {};
    const legacyProject = !services.some((s) => s.responsible_user_id);
    services.forEach((s) => {
      const legacy = legacyProject ? team.find((t) => t.project_role === s.service?.family?.default_project_role)?.user?.id : undefined;
      initial[s.id] = s.responsible_user_id ?? legacy ?? "";
    });
    setByService(initial);
    const direct = new Set(Object.values(initial).filter(Boolean));
    const opts = steps.data ?? [];
    const users = new Set([...team.filter((t) => t.project_role === "support" && !direct.has(t.user!.id)).map((t) => t.user!.id),
      ...opts.map((o) => o.user_id).filter((u): u is string => !!u)]);
    setIndirect([...users].map((u) => ({ user: u, steps: opts.filter((o) => o.user_id === u).map(stepKey) })));
    setAdding(""); setErr(null); setJustAdded(null);
  }, [open, project, services, steps.data]);

  const isStart = project.status === "awaiting_team_assignment";
  const people = staff.data ?? [];
  const label = (m: StaffMember) => `${m.name} · ${m.employment_type ? EMPLOYMENT_LABEL[m.employment_type] : ROLE_LABEL[m.role]}`;
  const missing = services.filter((s) => !byService[s.id]).length;

  const stepOptions = steps.data ?? [];
  const optionByKey = useMemo(() => new Map(stepOptions.map((o) => [stepKey(o), o])), [stepOptions]);
  const nameOf = (id: string) => people.find((m) => m.id === id)?.name ?? "outra pessoa";
  const setSteps = (user: string, keys: string[]) => setIndirect((xs) => xs.map((x) =>
    x.user === user ? { ...x, steps: keys } : { ...x, steps: x.steps.filter((k) => !keys.includes(k)) }));

  async function save() {
    const missingLead = LEAD_AREAS.filter((a) => !leads[a.area]);
    if (missingLead.length) { setErr(`Escolha o líder de ${missingLead.map((a) => a.label).join(", ")}. Pode ser a mesma pessoa nas três áreas.`); return; }
    const noSteps = stepOptions.length ? indirect.filter((x) => x.steps.length === 0) : [];
    if (noSteps.length) { setErr(`Escolha ao menos uma etapa para ${noSteps.map((x) => nameOf(x.user)).join(", ")}, ou remova a pessoa.`); return; }
    setSaving(true); setErr(null);
    try {
      const assignments = [
        ...LEAD_AREAS.map((a) => ({ project_role: a.role, user_id: leads[a.area] })),
        ...services.filter((s) => byService[s.id]).map((s) => ({ project_service_id: s.id, user_id: byService[s.id] })),
        ...indirect.map((x) => ({ project_role: "support", user_id: x.user })),
      ];
      const res = await api.assignTeam(project.id, assignments);
      if (!steps.error) {
        await api.setStepAssignments(project.id, indirect.flatMap((x) => x.steps.map((k) => optionByKey.get(k))
          .filter((o): o is StepOption => !!o).map((o) => ({ project_service_id: o.project_service_id, task_code: o.task_code, user_id: x.user }))));
      }
      toast(res.started ? "Equipe confirmada. Projeto iniciado e cronograma gerado." : "Equipe atualizada.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose}
      title={isStart ? "Revisar e atribuir equipe" : "Editar equipe"}
      subtitle={`${project.name}${project.code ? ` · ${project.code}` : ""}`}
      footer={
        <>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={saving} onClick={save}>{isStart ? "Confirmar equipe e iniciar projeto" : "Salvar equipe"}</Button>
        </>
      }>
      <div className="form">
        {err && <Alert tone="danger" title="Equipe não salva">{err}</Alert>}
        <Card className="mini-summary">
          <dl className="kv">
            <div><dt>Cliente</dt><dd>{project.client?.name ?? "—"} · {CLIENT_TYPE_LABEL[project.client_type]}</dd></div>
            <div><dt>Fechamento</dt><dd>{formatDate(project.contracted_at, true)}{project.city ? ` · ${project.city}` : ""}</dd></div>
          </dl>
        </Card>

        {staff.error ? <LoadError message={staff.error} onRetry={staff.reload} /> :
         staff.loading ? <Skeleton height={200} /> :
         people.length === 0 ? (
          <Alert tone="warning" title="Nenhuma pessoa ativa na unidade executora">
            Convide líderes e colaboradores em Controle de Acessos antes de definir a equipe.
          </Alert>
        ) : (
          <>
            <fieldset className="form__group">
              <legend className="label">Liderança <span className="req" aria-hidden="true">*</span></legend>
              <p className="subtext">Um líder por área, definido desde já. Pode ser a mesma pessoa nas três. Se o cliente contratar um serviço de outra área depois, o líder já estará definido.</p>
              {LEAD_AREAS.map((a) => {
                const covered = services.filter((s) => (s.service?.leadership_area ?? "architecture") === a.area).map((s) => s.service?.name).filter(Boolean);
                const other = leads[a.area] && LEAD_AREAS.some((b) => b.area !== a.area && leads[b.area] !== leads[a.area]);
                return (
                  <Field key={a.area} label={`Líder de ${a.label}`} required
                    hint={covered.length ? `Neste projeto: ${covered.join(", ")}` : "Nenhum serviço desta área contratado ainda"}>
                    {({ id, describedBy }) => (
                      <div className="lead-row">
                        <Select id={id} aria-describedby={describedBy} value={leads[a.area]}
                          onChange={(e) => setLeads((l) => ({ ...l, [a.area]: e.target.value }))}>
                          <option value="">Selecione</option>
                          {people.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                        </Select>
                        {other && (
                          <Button variant="ghost" size="sm" title="Usar esta pessoa nas três áreas"
                            onClick={() => setLeads({ architecture: leads[a.area], engineering: leads[a.area], approval: leads[a.area] })}>Usar nas 3</Button>
                        )}
                      </div>
                    )}
                  </Field>
                );
              })}
            </fieldset>

            <fieldset className="form__group">
              <legend className="label">Responsáveis diretos</legend>
              <p className="subtext">Quem conduz cada serviço e fala com o cliente. As etapas do serviço já nascem com esta pessoa; cada etapa pode ter outro responsável depois.</p>
              {services.map((s) => (
                <Field key={s.id} label={s.service?.name ?? "Serviço"} hint={s.status === "pending_review" ? "Serviço novo, ainda não incluído no cronograma" : s.service?.family?.name}>
                  {({ id, describedBy }) => (
                    <Select id={id} aria-describedby={describedBy} value={byService[s.id] ?? ""}
                      onChange={(e) => setByService((x) => ({ ...x, [s.id]: e.target.value }))}>
                      <option value="">Sem responsável</option>
                      {people.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                    </Select>
                  )}
                </Field>
              ))}
              {missing > 0 && <p className="subtext text-warning">{missing === 1 ? "1 serviço sem responsável direto." : `${missing} serviços sem responsável direto.`} Você pode definir depois.</p>}
            </fieldset>

            <fieldset className="form__group">
              <legend className="label">Colaboradores indiretos <span className="muted">· opcional</span></legend>
              <p className="subtext">Profissionais que respondem só por algumas sub-etapas (executivo, imagens e vídeo 3D, detalhamento…). Escolha a pessoa e marque as etapas dela; as demais etapas seguem com o responsável direto.</p>
              {steps.error && <LoadError message={steps.error} onRetry={steps.reload} />}
              {indirect.length > 0 && (
                <ul className="indirect-list">
                  {indirect.map((x) => {
                    const m = people.find((p) => p.id === x.user);
                    return (
                      <li key={x.user} className="indirect">
                        <div className="indirect__head">
                          <span className="ident grow"><Avatar name={m?.name ?? "?"} src={m?.avatar_url} size="sm" />
                            <span className="ident__text"><span className="ident__name truncate">{m?.name ?? "Pessoa da equipe"}</span>
                              <span className="ident__sub">{[m?.employment_type ? EMPLOYMENT_LABEL[m.employment_type] : null,
                                x.steps.length ? `${x.steps.length} ${x.steps.length === 1 ? "etapa" : "etapas"}` : null].filter(Boolean).join(" · ")}</span></span></span>
                          <Button variant="ghost" size="sm" iconOnly icon="x" onClick={() => setIndirect((xs) => xs.filter((y) => y.user !== x.user))}>Remover {m?.name}</Button>
                        </div>
                        {x.steps.length > 0 ? (
                          <ul className="indirect__steps" aria-label={`Etapas de ${m?.name ?? "colaborador"}`}>
                            {x.steps.map((k) => {
                              const o = optionByKey.get(k);
                              return (
                                <li key={k} className="step-chip">
                                  <span className="step-chip__name">{o?.task_name ?? "Etapa"}</span>
                                  <span className="step-chip__svc">{o?.service_name}</span>
                                  <button type="button" aria-label={`Desvincular ${o?.task_name}`} onClick={() => setSteps(x.user, x.steps.filter((y) => y !== k))}><Icon name="x" size={12} /></button>
                                </li>
                              );
                            })}
                          </ul>
                        ) : stepOptions.length > 0 && <p className="subtext text-warning">Nenhuma etapa vinculada ainda.</p>}
                        {stepOptions.length > 0 && (
                          <StepAssignPicker options={stepOptions} selected={x.steps} label={`Etapas de ${m?.name ?? "colaborador"}`}
                            autoOpen={justAdded === x.user}
                            ownerOf={(k) => { const o = indirect.find((y) => y.user !== x.user && y.steps.includes(k)); return o ? nameOf(o.user) : null; }}
                            onChange={(keys) => setSteps(x.user, keys)} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="row">
                <Select aria-label="Adicionar colaborador indireto" value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">Escolha o colaborador…</option>
                  {people.filter((m) => !Object.values(leads).includes(m.id) && !indirect.some((x) => x.user === m.id))
                    .map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                </Select>
                <Button variant="outline" size="sm" icon="plus" disabled={!adding}
                  onClick={() => { setIndirect((xs) => [...xs, { user: adding, steps: [] }]); setJustAdded(adding); setAdding(""); }}>Adicionar</Button>
              </div>
            </fieldset>
          </>
        )}
        <p className="subtext">
          {isStart
            ? "Ao confirmar: os vínculos são criados, o projeto passa para \"Em andamento\", o cronograma é gerado e cada pessoa recebe um aviso."
            : "Quem sair da equipe perde o acesso ao projeto. Etapas abertas acompanham a troca do responsável direto; etapas com responsável próprio ficam como estão."}
        </p>
      </div>
    </Drawer>
  );
}

/* ==========================================================================
   Distribuição (ADM Global)
   ========================================================================== */
function AllocateDrawer({ open, project, onClose, onSaved }: {
  open: boolean; project: ProjectDetail; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const tenants = useAsync(() => (open ? api.listTenants() : Promise.resolve([] as Tenant[])), [open]);
  const [tenantId, setTenantId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { if (open) { setTenantId(project.delivery_tenant_id ?? ""); setNotes(""); setErr(null); } }, [open, project]);

  async function save() {
    if (!tenantId) { setErr("Escolha a unidade executora."); return; }
    setSaving(true); setErr(null);
    try {
      await api.allocateProject(project.id, tenantId, notes);
      toast("Projeto distribuído.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Distribuir projeto" subtitle={project.name}
      footer={<><span className="spacer" /><Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button loading={saving} onClick={save}>Confirmar unidade</Button></>}>
      <div className="form">
        {err && <Alert tone="danger" title="Não foi distribuído">{err}</Alert>}
        <Field label="Unidade executora" required hint="A unidade escolhida recebe o aviso para definir a equipe.">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">Selecione</option>
              {(tenants.data ?? []).filter((t) => t.status === "ativo").map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.city ? ` · ${t.city}/${t.state ?? ""}` : ""}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Observação" hint="Opcional. Fica no histórico de distribuição.">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>
        <Alert tone="info">Métodos automáticos (territorial, rodízio, capacidade e outros) estão previstos e serão habilitados no futuro.</Alert>
      </div>
    </Drawer>
  );
}
