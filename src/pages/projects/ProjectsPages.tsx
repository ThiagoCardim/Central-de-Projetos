import { useEffect, useMemo, useState } from "react";
import { api } from "@/services/api";
import { useAuth } from "@/services/auth";
import { useAsync, useDocumentTitle, useIsMobile } from "@/hooks";
import { Link, useNavigate, useParams, useSearchParam } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import {
  Alert, Avatar, Badge, Button, Card, EmptyState, Field, FilterBar, Input, LoadError, SearchInput, Select, Skeleton, Tabs,
} from "@/components/ui/primitives";
import { Drawer, useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { ProjectDetail, ProjectListItem, ProjectRole, ProjectStatus, StaffMember, Tenant } from "@/types/domain";
import {
  ALLOCATION_METHOD_LABEL, CLIENT_TYPE_LABEL, EMPLOYMENT_LABEL, formatDate, formatDateTime, PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE, ROLE_LABEL, SERVICE_STATUS_LABEL,
} from "@/utils/format";

type TabKey = "pending" | "active" | "done" | "all";

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

  const all = data ?? [];
  const isPending = (p: ProjectListItem) => p.status === "awaiting_allocation" || p.status === "awaiting_team_assignment";
  const counts = {
    pending: all.filter(isPending).length,
    active: all.filter((p) => p.status === "in_progress" || p.status === "on_hold").length,
    done: all.filter((p) => p.status === "completed" || p.status === "cancelled").length,
    all: all.length,
  };
  const list = all.filter((p) => {
    if (tab === "pending" && !isPending(p)) return false;
    if (tab === "active" && !(p.status === "in_progress" || p.status === "on_hold")) return false;
    if (tab === "done" && !(p.status === "completed" || p.status === "cancelled")) return false;
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
      />
      <Tabs<TabKey> label="Situação dos projetos" value={tab} onChange={setTab} tabs={[
        { value: "pending", label: "Aguardando ação", count: counts.pending },
        { value: "active", label: "Em andamento", count: counts.active },
        { value: "done", label: "Encerrados", count: counts.done },
        { value: "all", label: "Todos", count: counts.all },
      ]} />
      <FilterBar active={!!q} onClear={() => setQ("")}>
        <SearchInput placeholder="Buscar por projeto, código, cliente ou cidade" aria-label="Buscar projetos" value={q} onChange={(e) => setQ(e.target.value)} />
      </FilterBar>

      {error ? <LoadError message={error} onRetry={reload} /> :
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
  const roles = useAsync(() => api.listProjectRoles(), []);
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

  const activeTeam = p.team.filter((t) => t.active);
  const roleName = (code: string) => roles.data?.find((r) => r.code === code)?.name ?? code;
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
          </>
        }
      />

      <ProjectStateBand p={p} canAssign={canAssign} canDistribute={canDistribute}
        onAssign={() => setTeamOpen(true)} onDistribute={() => setAllocOpen(true)} pendingServices={pendingServices.length} />

      <div className="detail-grid">
        <div className="stack" style={{ gap: 16 }}>
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
            <p className="subtext card__note">O cronograma de cada serviço é gerado na Etapa 3, a partir dos templates YouCon.</p>
          </Card>

          <Card title="Equipe" count={activeTeam.length || undefined}>
            {activeTeam.length === 0 ? (
              <EmptyState compact icon="users" title="Equipe ainda não definida."
                text={canAssign ? "Defina um responsável por função para iniciar o projeto." : "O líder da unidade executora definirá a equipe."} />
            ) : (
              <ul className="team-list">
                {[...activeTeam].sort((a, b) => (roles.data?.findIndex((r) => r.code === a.project_role) ?? 0)
                                                - (roles.data?.findIndex((r) => r.code === b.project_role) ?? 0)).map((t) => (
                  <li key={t.id}>
                    <span className="label team-list__role">{roleName(t.project_role)}</span>
                    <span className="ident">
                      <Avatar name={t.user?.name ?? "?"} src={t.user?.avatar_url} size="sm" />
                      <span className="ident__name truncate">{t.user?.name ?? "Pessoa de outra unidade"}{t.user?.id === profile?.id && <span className="muted"> (você)</span>}</span>
                    </span>
                    {t.employment_type && <Badge tag outline>{EMPLOYMENT_LABEL[t.employment_type]}</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
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
        <TeamDrawer open={teamOpen} project={p} roles={roles.data ?? []}
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
        Defina o Líder do Projeto e os responsáveis por função. A confirmação inicia o projeto e libera o acesso da equipe e do cliente.
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
   Atribuição de equipe por função
   ========================================================================== */
function TeamDrawer({ open, project, roles, onClose, onSaved }: {
  open: boolean; project: ProjectDetail; roles: ProjectRole[]; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const staff = useAsync(() => (open && project.delivery_tenant_id ? api.listStaff(project.delivery_tenant_id) : Promise.resolve([] as StaffMember[])),
    [open, project.delivery_tenant_id]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [extraRoles, setExtraRoles] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Funções sugeridas a partir das famílias dos serviços contratados.
  const suggested = useMemo(() => {
    const set = new Set<string>(["project_lead"]);
    project.services.filter((s) => s.active).forEach((s) => {
      const r = s.service?.family?.default_project_role;
      if (r) set.add(r);
    });
    project.team.filter((t) => t.active).forEach((t) => set.add(t.project_role));
    return set;
  }, [project]);

  useEffect(() => {
    if (!open) return;
    const initial: Record<string, string> = {};
    project.team.filter((t) => t.active && t.user).forEach((t) => { initial[t.project_role] = t.user!.id; });
    setPicks(initial); setExtraRoles([]); setErr(null);
  }, [open, project]);

  const visibleRoles = roles.filter((r) => suggested.has(r.code) || extraRoles.includes(r.code));
  const hiddenRoles = roles.filter((r) => !suggested.has(r.code) && !extraRoles.includes(r.code));
  const isStart = project.status === "awaiting_team_assignment";

  async function save() {
    if (!picks.project_lead) { setErr("Escolha o Líder do Projeto."); return; }
    setSaving(true); setErr(null);
    try {
      const assignments = Object.entries(picks).filter(([, u]) => u).map(([project_role, user_id]) => ({ project_role, user_id }));
      const res = await api.assignTeam(project.id, assignments);
      toast(res.started ? "Equipe confirmada. Projeto iniciado." : "Equipe atualizada.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const option = (m: StaffMember) => `${m.name} · ${m.employment_type ? EMPLOYMENT_LABEL[m.employment_type] : ROLE_LABEL[m.role]}`;

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
            <div><dt>Serviços</dt><dd>{project.services.filter((s) => s.active).map((s) => s.service?.name).join(", ")}</dd></div>
            <div><dt>Fechamento</dt><dd>{formatDate(project.contracted_at, true)}{project.city ? ` · ${project.city}` : ""}</dd></div>
          </dl>
        </Card>

        {staff.error ? <LoadError message={staff.error} onRetry={staff.reload} /> :
         staff.loading ? <Skeleton height={160} /> :
         (staff.data ?? []).length === 0 ? (
          <Alert tone="warning" title="Nenhuma pessoa ativa na unidade executora">
            Convide líderes e colaboradores em Controle de Acessos antes de definir a equipe.
          </Alert>
        ) : (
          <fieldset className="form__group">
            <legend className="label">Responsável por função</legend>
            {visibleRoles.map((r) => (
              <Field key={r.code} label={r.name} required={r.code === "project_lead"}>
                {({ id }) => (
                  <Select id={id} value={picks[r.code] ?? ""} onChange={(e) => setPicks((p) => ({ ...p, [r.code]: e.target.value }))}>
                    <option value="">{r.code === "project_lead" ? "Selecione" : "Sem responsável"}</option>
                    {(staff.data ?? []).map((m) => <option key={m.id} value={m.id}>{option(m)}</option>)}
                  </Select>
                )}
              </Field>
            ))}
            {hiddenRoles.length > 0 && (
              <div className="row" style={{ flexWrap: "wrap" }}>
                <span className="subtext">Adicionar função:</span>
                {hiddenRoles.map((r) => (
                  <Button key={r.code} size="sm" variant="outline" icon="plus" onClick={() => setExtraRoles((x) => [...x, r.code])}>{r.name}</Button>
                ))}
              </div>
            )}
          </fieldset>
        )}
        <p className="subtext">
          {isStart
            ? "Ao confirmar: os vínculos são criados, o projeto passa para \"Em andamento\", cada pessoa recebe um aviso e o cliente passa a acompanhar o projeto."
            : "Quem sair da equipe perde o acesso ao projeto. O histórico fica na auditoria."}
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
