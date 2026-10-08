import { useMemo, useState } from "react";
import { useAuth } from "@/services/auth";
import { api } from "@/services/api";
import { useAsync, useDocumentTitle } from "@/hooks";
import { Link, useNavigate } from "@/lib/router";
import { PageHead } from "@/layouts/AppLayout";
import {
  Avatar, Badge, Button, Card, EmptyState, LoadError, MetricCard, ProgressBar, SearchInput, Skeleton,
} from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { AwaitingTeamCard, StepTimeline, TaskList } from "@/components/domain/cards";
import { computeNextStep, type NextStep } from "./nextStep";
import { PendingAdjustmentsCard } from "@/pages/schedule/Adjustments";
import { MyDayCard, TeamTasksCard, useWorkSummary } from "./WorkCards";
import { HighlightsCard, MyPerformanceCard } from "./PerfCards";
import { myDayStats, teamStats } from "@/pages/work/workStats";
import { todayISO } from "@/pages/schedule/model";
import type { ClientProject, ClientScheduleChange, HomeDashboard, Permissions } from "@/types/domain";
import {
  cx, EMPLOYMENT_LABEL, firstName, formatDate, formatToday, greeting, PROJECT_STATUS_LABEL, ROLE_LABEL, TENANT_TYPE_LABEL,
} from "@/utils/format";

export function HomePage() {
  useDocumentTitle("Início");
  const { permissions } = useAuth();
  const { data, error, loading, reload } = useAsync(() => api.homeDashboard(), []);

  if (error && !data) {
    return <div className="page"><LoadError message={error} onRetry={reload} /></div>;
  }
  if (loading && !data) return <HomeSkeleton />;
  if (!data) return null;

  return (
    <div className="page home">
      <HomeHeader d={data} />
      <NextStepBand step={computeNextStep(data, permissions)} />
      {data.client ? <ClientHome projects={data.client.projects} /> : <StaffHome d={data} perms={permissions} />}
    </div>
  );
}

function HomeHeader({ d }: { d: HomeDashboard }) {
  const role = [ROLE_LABEL[d.me.role], d.me.employment_type && EMPLOYMENT_LABEL[d.me.employment_type]].filter(Boolean).join(" ");
  return (
    <PageHead
      title={`${greeting()}, ${firstName(d.me.name)}`}
      subtitle={<>{formatToday()} <span className="sep" aria-hidden="true" /> {d.me.role === "client" ? "Seus projetos YouCon" : `${role}, ${d.me.tenant.name}`}</>}
    />
  );
}

/** Faixa "Próximo passo": responde "o que preciso fazer agora?" em uma frase. */
function NextStepBand({ step }: { step: NextStep }) {
  const navigate = useNavigate();
  return (
    <section className={cx("nextstep", `nextstep--${step.tone}`)} aria-labelledby="nextstep-title">
      <span className="nextstep__icon"><Icon name={step.icon} /></span>
      <div className="nextstep__text">
        <span className="label">Próximo passo</span>
        <h2 id="nextstep-title" className="nextstep__headline">{step.headline}</h2>
        {step.context && <p className="nextstep__context">{step.context}</p>}
      </div>
      {step.action && (
        step.action.to
          ? <Button size="lg" onClick={() => navigate(step.action!.to!)}>{step.action.label}</Button>
          : <Button size="lg" variant="secondary" aria-disabled="true" title={step.action.disabledReason}
              onClick={(e) => e.preventDefault()}>{step.action.label}</Button>
      )}
    </section>
  );
}

/* ==========================================================================
   Equipe interna (colaborador, líder, ADM)
   ========================================================================== */
function StaffHome({ d, perms }: { d: HomeDashboard; perms: Permissions | null }) {
  const ops = d.operations;
  const mine = d.my_work!;
  const names = useMemo(() => new Map((ops?.team_load ?? []).map((m) => [m.id, m.name])), [ops]);
  const navigate = useNavigate();
  const pendingAdj = useAsync(() => (perms?.is_manager ? api.myPendingAdjustments() : Promise.resolve([])), [perms?.is_manager]);
  const isManager = !!perms?.is_manager;
  const work = useWorkSummary(isManager);
  const today = todayISO();
  const day = work.mine ? myDayStats(work.mine, today) : null;
  const team = work.team ? teamStats(work.team, today) : null;
  const toTasks = () => navigate("/minhas-tarefas");
  const toTeam = () => navigate("/minhas-tarefas?aba=equipe");

  return (
    <>
      <div className="metrics">
        {ops ? (
          <>
            <MetricCard label="Projetos ativos" value={ops.counts.projects_active} />
            <MetricCard label="Aguardando equipe" value={ops.counts.awaiting_team} tone={ops.counts.awaiting_team ? "brand" : "quiet"} />
            <MetricCard label="Etapas atrasadas" value={ops.counts.tasks_overdue} tone={ops.counts.tasks_overdue ? "danger" : "quiet"}
              hint={ops.counts.projects_at_risk ? `${ops.counts.projects_at_risk} em risco` : "Nenhum risco"} />
            <MetricCard label="Bloqueadas" value={ops.counts.tasks_blocked} tone={ops.counts.tasks_blocked ? "warning" : "quiet"} />
            <MetricCard label="Aguardando cliente" value={ops.counts.tasks_waiting_client} tone={ops.counts.tasks_waiting_client ? "warning" : "quiet"} />
            <MetricCard label="Sem responsável" value={ops.counts.tasks_unassigned} tone={ops.counts.tasks_unassigned ? "warning" : "quiet"} />
            <MetricCard label="Vencem em 7 dias" value={ops.counts.due_next_7} />
            {isManager && team && (
              <MetricCard label="Tarefas atrasadas" value={team.late} tone={team.late ? "danger" : "quiet"} onClick={toTeam}
                hint={`Da equipe · ${team.open} em aberto`} />
            )}
          </>
        ) : (
          <>
            <MetricCard label="Minhas etapas abertas" value={mine.counts.open} />
            <MetricCard label="Atrasadas" value={mine.counts.overdue} tone={mine.counts.overdue ? "danger" : "quiet"} />
            <MetricCard label="Vencem hoje" value={mine.counts.due_today} tone={mine.counts.due_today ? "brand" : "quiet"} />
            <MetricCard label="Próximos 7 dias" value={mine.counts.due_next_7} />
            <MetricCard label="Aguardando cliente" value={mine.counts.waiting_client} tone={mine.counts.waiting_client ? "warning" : "quiet"} />
            <MetricCard label="Bloqueadas" value={mine.counts.blocked} tone={mine.counts.blocked ? "warning" : "quiet"} />
            {day && (
              <>
                <MetricCard label="Tarefas para hoje" value={day.dueToday.length} tone={day.dueToday.length ? "brand" : "quiet"} onClick={toTasks}
                  hint={`${day.doneToday.length} ${day.doneToday.length === 1 ? "feita" : "feitas"} hoje`} />
                <MetricCard label="Tarefas atrasadas" value={day.late.length} tone={day.late.length ? "danger" : "quiet"} onClick={toTasks}
                  hint={day.fromLead ? `${day.fromLead} da liderança` : "Pendentes de dias anteriores"} />
              </>
            )}
          </>
        )}
      </div>

      <div className="home__grid">
        <div className="home__main">
          <PendingAdjustmentsCard items={pendingAdj.data ?? []}
            onOpen={(r) => navigate(`/projetos/${r.project_id}/cronograma?aba=ajustes`)} />
          {!ops && work.mine && <MyDayCard items={work.mine} today={today} onChange={work.setMine} />}
          {isManager && work.team && <TeamTasksCard items={work.team} today={today} />}
          {isManager && <HighlightsCard isManager />}
          {ops && (
            <Card title="Novos projetos aguardando equipe" count={ops.awaiting_team.length || undefined}>
              {ops.awaiting_team.length ? (
                <div className="pcards">{ops.awaiting_team.map((p) => <AwaitingTeamCard key={p.id} project={p} />)}</div>
              ) : (
                <EmptyState compact icon="userPlus" title="Nenhum projeto aguardando equipe."
                  text="Quando um projeto for distribuído para sua unidade, ele aparecerá aqui para você atribuir os responsáveis." />
              )}
            </Card>
          )}

          {ops && (
            <Card title="Atenção agora" count={ops.alerts.length || undefined} flush>
              {ops.alerts.length ? (
                <TaskList tasks={ops.alerts} showResponsible names={names} />
              ) : (
                <EmptyState compact title="Nenhum alerta na unidade."
                  text="Atrasos, bloqueios, pendências de cliente e etapas sem responsável aparecerão aqui." />
              )}
            </Card>
          )}

          {!ops && <MyTasksCard mine={mine} />}
        </div>

        <aside className="home__side">
          {!isManager && perms?.can_view_performance && <MyPerformanceCard />}
          {!isManager && perms?.can_view_performance && <HighlightsCard isManager={false} />}
          {ops && work.mine && <MyDayCard items={work.mine} today={today} onChange={work.setMine} />}
          {ops && <TeamLoadCard team={ops.team_load} />}
          {ops && <MyTasksCard mine={mine} />}
          {d.admin && <UsersCard d={d} perms={perms} />}
          {d.admin && perms?.can_view_intake && <IntakeCard d={d} />}
          <MyProjectsCard projects={mine.projects} />
        </aside>
      </div>

      {d.admin?.tenants && <UnitsCard d={d} />}
    </>
  );
}

/** Minhas etapas: coluna principal para colaboradores, lateral para gestores. */
function MyTasksCard({ mine }: { mine: NonNullable<HomeDashboard["my_work"]> }) {
  return (
    <Card title="Minhas etapas" count={mine.counts.open || undefined} flush action={<Link to="/minhas-tarefas" className="link card__link">Minhas tarefas</Link>}>
      {mine.tasks.length ? (
        <TaskList tasks={mine.tasks} />
      ) : (
        <EmptyState compact icon="checkCircle" title="Nenhuma etapa atribuída a você."
          text="Quando uma nova atividade for atribuída, ela aparecerá aqui." />
      )}
    </Card>
  );
}

function TeamLoadCard({ team }: { team: { id: string; name: string; open: number; overdue: number }[] }) {
  const max = Math.max(1, ...team.map((m) => m.open));
  return (
    <Card title="Carga da equipe">
      {team.length ? (
        <ul className="load">
          {team.map((m) => (
            <li key={m.id} className="load__row">
              <span className="load__name truncate">{m.name}</span>
              <span className="load__bar" aria-hidden="true">
                <span style={{ width: `${(m.open / max) * 100}%` }} />
                {m.overdue > 0 && <span className="load__overdue" style={{ width: `${(m.overdue / max) * 100}%` }} />}
              </span>
              <span className="load__value num">
                {m.open}{m.overdue > 0 && <em> · {m.overdue} atras.</em>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon="users" title="Nenhum colaborador ativo." text="Convide a equipe em Controle de Acessos." />
      )}
    </Card>
  );
}

function UsersCard({ d, perms }: { d: HomeDashboard; perms: Permissions | null }) {
  const u = d.admin!.users;
  return (
    <Card title="Usuários" action={perms?.can_manage_users && <Link to="/acessos" className="link">Gerenciar</Link>}>
      <dl className="kv">
        <div><dt>Equipe ativa</dt><dd className="num">{u.active}</dd></div>
        <div><dt>CLT / PJ</dt><dd className="num">{u.clt} / {u.pj}</dd></div>
        <div><dt>Clientes com acesso</dt><dd className="num">{u.clients}</dd></div>
        <div><dt>Convites pendentes</dt><dd className="num">{u.pending_invite}</dd></div>
        <div><dt>Inativos</dt><dd className="num">{u.inactive}</dd></div>
      </dl>
    </Card>
  );
}

function IntakeCard({ d }: { d: HomeDashboard }) {
  const i = d.admin!.intake;
  return (
    <Card title="Central de Entrada" action={<Link to="/entrada" className="link">Abrir</Link>}>
      <dl className="kv">
        <div><dt>Aguardando processamento</dt><dd className="num">{i.received}</dd></div>
        <div><dt>Com erro</dt><dd className={cx("num", i.errors > 0 && "text-danger")}>{i.errors}</dd></div>
        <div><dt>Recebidas em 24h</dt><dd className="num">{i.last_24h}</dd></div>
      </dl>
    </Card>
  );
}

function MyProjectsCard({ projects }: { projects: NonNullable<HomeDashboard["my_work"]>["projects"] }) {
  if (projects.length === 0) return null;
  return (
    <Card title="Meus projetos" count={projects.length}>
      <ul className="plist">
        {projects.map((p) => (
          <li key={p.id}>
            <span className="grow">
              <span className="plist__name truncate">{p.name}</span>
              <span className="plist__meta">{p.project_role}{p.code ? ` · ${p.code}` : ""}</span>
            </span>
            <Badge>{PROJECT_STATUS_LABEL[p.status]}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function UnitsCard({ d }: { d: HomeDashboard }) {
  const tenants = d.admin!.tenants!;
  return (
    <Card title="Rede YouCon" count={tenants.length} flush action={<Link to="/unidades" className="link card__link">Ver unidades</Link>}>
      <div className="table-scroll">
        <table className="list">
          <thead>
            <tr>
              <th>Unidade</th><th>Projetos ativos</th><th>Aguardando</th><th>Equipe</th><th>CLT / PJ</th><th>Clientes</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.tenant_id} className={t.status === "inativo" ? "is-inactive" : undefined}>
                <td>
                  <span className="ident__name">{t.name}</span>{" "}
                  <span className="muted subtext">{TENANT_TYPE_LABEL[t.type]}{t.status === "inativo" ? " · inativa" : ""}</span>
                </td>
                <td className="num">{t.projects_active}</td>
                <td className="num">{t.projects_awaiting > 0 ? <Badge tone="brand">{t.projects_awaiting}</Badge> : 0}</td>
                <td className="num">{t.users_active}</td>
                <td className="num">{t.collaborators_clt} / {t.collaborators_pj}</td>
                <td className="num">{t.clients}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ==========================================================================
   Cliente: visão simples e visual
   ========================================================================== */
function ClientHome({ projects }: { projects: ClientProject[] }) {
  // Histórico de alterações de prazo (com motivo) dos projetos do cliente.
  const changes = useAsync(() => api.clientScheduleChanges(null, 100), []);
  if (projects.length === 0) {
    return (
      <div className="stack client">
        <Card>
          <EmptyState icon="folder" title="Seu projeto ainda não tem cronograma."
            text="A equipe YouCon está organizando as próximas etapas. Você será avisado quando tudo estiver definido." />
        </Card>
        <FaqPrompt />
      </div>
    );
  }
  return (
    <div className="stack client">
      {projects.map((p) => (
        <ClientProjectCard key={p.id} project={p}
          changes={changes.data ? changes.data.filter((c) => c.project_id === p.id) : null} />
      ))}
      <FaqPrompt />
    </div>
  );
}

/** Atalho para as Dúvidas frequentes: o cliente já escreve a dúvida aqui. */
function FaqPrompt() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  return (
    <Card className="faqp">
      <div className="faqp__text">
        <span className="faqp__icon" aria-hidden="true"><Icon name="help" /></span>
        <div>
          <h2 className="faqp__title">Ficou com alguma dúvida?</h2>
          <p className="faqp__sub">Documentação, aprovação, taxas, prazos: escreva sua pergunta e veja a resposta na hora.</p>
        </div>
      </div>
      <form className="faqp__form" role="search" onSubmit={(e) => { e.preventDefault(); navigate(text.trim() ? `/duvidas?q=${encodeURIComponent(text.trim())}` : "/duvidas"); }}>
        <SearchInput aria-label="Sua dúvida" placeholder="Ex.: quem paga as taxas?" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" icon="search">Buscar</Button>
      </form>
    </Card>
  );
}

function ClientProjectCard({ project: p, changes }: { project: ClientProject; changes: ClientScheduleChange[] | null }) {
  return (
    <Card as="article" className="cproject" aria-label={p.name}>
      <header className="cproject__head">
        <div className="grow">
          <h2 className="cproject__name">{p.name}</h2>
          <p className="subtext">
            {PROJECT_STATUS_LABEL[p.status]}
            {p.city ? ` · ${p.city}${p.state ? `/${p.state}` : ""}` : ""}
            {p.code ? ` · ${p.code}` : ""}
          </p>
        </div>
        <div className="cproject__kpis">
          <div><span className="label">Progresso</span><span className="cproject__kpi num">{p.progress}%</span></div>
          <div><span className="label">Previsão</span><span className="cproject__kpi">{p.forecast_end ? formatDate(p.forecast_end, true) : "A definir"}</span></div>
        </div>
      </header>
      <ProgressBar value={p.progress} label={`Progresso de ${p.name}`} />
      {p.pending_from_client > 0 && (
        <div className="cproject__pending">
          <Icon name="alert" size={16} />
          <span>{p.pending_from_client === 1 ? "Uma etapa depende de informações suas." : `${p.pending_from_client} etapas dependem de informações suas.`}</span>
        </div>
      )}
      <div className="cservices">
        {p.services.map((s) => (
          <section key={s.name} className="cservice" aria-label={s.name}>
            <header className="row-between">
              <h3>{s.name}</h3>
              <span className="subtext num">{s.progress}%</span>
            </header>
            <ProgressBar value={s.progress} label={`Progresso de ${s.name}`} thin />
            <dl className="cservice__now">
              <div><dt className="label">Etapa atual</dt><dd>{s.current_step?.name ?? (s.progress === 100 ? "Concluído" : "A iniciar")}</dd></div>
              <div><dt className="label">Próxima</dt><dd>{s.next_step?.name ?? "—"}</dd></div>
            </dl>
            <StepTimeline steps={s.steps} />
          </section>
        ))}
      </div>
      <ProjectTeam projectId={p.id} />
      {changes && changes.length > 0 && <ClientChanges changes={changes} />}
    </Card>
  );
}

/** Quem cuida do projeto: liderança e responsáveis pelos serviços contratados. */
function ProjectTeam({ projectId }: { projectId: string }) {
  const q = useAsync(() => api.clientProjectTeam(projectId), [projectId]);
  const team = q.data ?? [];
  if (q.loading && !q.data) return <Skeleton height={120} radius={12} />;
  if (team.length === 0) return null;
  return (
    <section className="cteam" aria-label="Equipe do seu projeto">
      <header className="cteam__head">
        <h3>Equipe do seu projeto</h3>
        <span className="subtext">Os profissionais responsáveis por cada parte do que você contratou</span>
      </header>
      <ul className="cteam__list">
        {team.map((m) => (
          <li key={m.id} className={cx("cmember", m.is_leader && "is-leader")}>
            <Avatar name={m.name} src={m.avatar_url} size="lg" />
            <div className="cmember__body">
              <div className="cmember__name">
                <strong>{m.name}</strong>
                {m.is_leader && <Badge tone="brand" tag>Liderança</Badge>}
              </div>
              <span className="cmember__roles">{m.roles.length ? m.roles.join(" · ") : m.areas.length ? m.areas.join(" · ") : "Equipe de apoio"}</span>
              {m.functions.length > 0 && (
                <span className="cmember__fns">{m.functions.map((f) => <span key={f} className="cmember__fn">{f}</span>)}</span>
              )}
              {m.bio && <p className="cmember__bio">{m.bio}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Alterações de prazo com o motivo registrado pela equipe. */
function ClientChanges({ changes }: { changes: ClientScheduleChange[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? changes : changes.slice(0, 3);
  return (
    <section className="cchanges" aria-label="Alterações de prazo">
      <header className="row-between">
        <h3 className="cchanges__title"><Icon name="calendar" size={16} /> Alterações de prazo</h3>
        <span className="subtext">{changes.length === 1 ? "1 registro" : `${changes.length} registros`}</span>
      </header>
      <ol className="cchanges__list">
        {shown.map((c) => {
          const later = c.before_end && c.after_end ? c.after_end > c.before_end : null;
          return (
            <li key={c.id} className="cchange">
              <div className="cchange__top">
                <strong>{c.task_name}</strong>
                {c.change_type === "reopened" && <Badge tone="warning" tag>Etapa reaberta</Badge>}
                {c.service_name && <span className="subtext">{c.service_name}</span>}
                <span className="cchange__when">{formatDate(c.changed_at.slice(0, 10), true)}</span>
              </div>
              <p className="cchange__dates">
                {c.change_type === "reopened" ? "Entregue em" : "Término previsto"}:{" "}
                <span className="cchange__before">{c.before_end ? formatDate(c.before_end, true) : "a definir"}</span>
                <Icon name="chevronRight" size={14} />
                {c.change_type === "reopened" && <span>nova entrega</span>}
                <span className={cx("cchange__after", later === true && "is-later", later === false && "is-earlier")}>
                  {c.after_end ? formatDate(c.after_end, true) : "a definir"}
                </span>
              </p>
              <p className="cchange__reason"><span className="label">Motivo</span> {c.reason ?? "Não informado"}
                {c.reason_detail ? <span className="cchange__detail"> · {c.reason_detail}</span> : null}</p>
            </li>
          );
        })}
      </ol>
      {changes.length > 3 && (
        <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)}>
          {all ? "Mostrar menos" : `Ver todas as ${changes.length} alterações`}
        </Button>
      )}
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="page home" aria-busy="true" aria-label="Carregando painel">
      <div className="stack" style={{ gap: 8 }}><Skeleton width={260} height={24} /><Skeleton width={340} height={14} /></div>
      <Skeleton height={92} radius={16} />
      <div className="metrics">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={84} radius={16} />)}</div>
      <div className="home__grid">
        <div className="home__main"><Skeleton height={220} radius={16} /><Skeleton height={260} radius={16} /></div>
        <div className="home__side"><Skeleton height={200} radius={16} /><Skeleton height={180} radius={16} /></div>
      </div>
    </div>
  );
}
