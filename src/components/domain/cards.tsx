// Componentes de domínio: TaskCard, ProjectCard (aguardando equipe) e Timeline do cliente.
import type { AwaitingTeamProject, ClientStep, TaskAlert } from "@/types/domain";
import { Badge } from "@/components/ui/primitives";
import { Link } from "@/lib/router";
import { Icon } from "@/components/ui/Icon";
import { alertPhrase, CLIENT_TYPE_LABEL, cx, formatDate, TASK_STATUS_LABEL, TASK_STATUS_TONE } from "@/utils/format";

/** Linha compacta de etapa com o alerta mais relevante. */
export function TaskCard({ task, showResponsible, responsibleName }: {
  task: TaskAlert; showResponsible?: boolean; responsibleName?: string | null;
}) {
  const alert = alertPhrase(task);
  return (
    <li className="task">
      <span className={cx("task__dot", `tone-${TASK_STATUS_TONE[task.status]}`)} title={TASK_STATUS_LABEL[task.status]}>
        <span className="sr-only">{TASK_STATUS_LABEL[task.status]}</span>
      </span>
      <div className="task__main">
        <span className="task__name truncate">{task.task_name}</span>
        <span className="task__meta truncate">
          {task.project_name} · {task.service_name}
          {showResponsible && <> · {responsibleName ?? <em className="task__nobody">sem responsável</em>}</>}
        </span>
      </div>
      <div className="task__side">
        <Badge tone={alert.tone}>{alert.text}</Badge>
        {task.planned_end_date && <span className="task__date num">{formatDate(task.planned_end_date)}</span>}
      </div>
    </li>
  );
}

export function TaskList({ tasks, showResponsible, names }: {
  tasks: TaskAlert[]; showResponsible?: boolean; names?: Map<string, string>;
}) {
  return (
    <ul className="tasklist">
      {tasks.map((t) => (
        <TaskCard key={t.task_id} task={t} showResponsible={showResponsible}
          responsibleName={t.responsible_user_id ? names?.get(t.responsible_user_id) ?? null : null} />
      ))}
    </ul>
  );
}

/** Card "Novo projeto aguardando equipe" (seção 34 do escopo). */
export function AwaitingTeamCard({ project }: { project: AwaitingTeamProject }) {
  return (
    <article className="pcard">
      <div className="pcard__head">
        <div className="grow">
          <p className="pcard__client truncate">{project.client_name}</p>
          <p className="pcard__name truncate">{project.name}{project.project_type ? ` · ${project.project_type}` : ""}</p>
        </div>
        <Badge tag outline>{CLIENT_TYPE_LABEL[project.client_type]}</Badge>
      </div>
      <ul className="pcard__services" aria-label="Serviços contratados">
        {project.services.length
          ? project.services.map((s) => <li key={s}>{s}</li>)
          : <li className="muted">Serviços a confirmar</li>}
      </ul>
      <div className="pcard__foot">
        <span className="pcard__meta">
          <Icon name="calendar" size={14} /> {formatDate(project.contracted_at, true)}
        </span>
        {project.city && (
          <span className="pcard__meta truncate">
            <Icon name="mapPin" size={14} /> {project.city}{project.state ? `/${project.state}` : ""}
          </span>
        )}
        <Link to={`/projetos/${project.id}?acao=equipe`} className="btn btn--secondary btn--sm pcard__cta">
          Revisar e atribuir equipe
        </Link>
      </div>
    </article>
  );
}

/** Linha do tempo simples para o cliente (sem Gantt técnico). */
export function StepTimeline({ steps }: { steps: ClientStep[] }) {
  if (steps.length === 0) return <p className="subtext">Cronograma em definição.</p>;
  const currentIndex = steps.findIndex((s) => s.status !== "completed");
  return (
    <ol className="timeline">
      {steps.map((s, i) => {
        const state = s.status === "completed" ? "done" : i === currentIndex ? "current" : "todo";
        return (
          <li key={`${s.name}-${i}`} className={`timeline__step is-${state}`}>
            <span className="timeline__mark" aria-hidden="true">{state === "done" && <Icon name="check" size={10} />}</span>
            <span className="timeline__name">{s.name}</span>
            <span className="timeline__date num">
              {state === "done" ? `Concluída ${formatDate(s.actual_end_date ?? s.planned_end_date)}`
                : s.status === "waiting_client" ? "Aguardando você"
                : s.planned_end_date ? `Previsão ${formatDate(s.planned_end_date)}` : "A definir"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
