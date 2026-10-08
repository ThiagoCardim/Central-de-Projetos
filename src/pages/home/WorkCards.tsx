import { useEffect, useState } from "react";
import { api } from "@/services/api";
import { Link, useNavigate } from "@/lib/router";
import { Avatar, Button, Card, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/overlays";
import { Icon } from "@/components/ui/Icon";
import type { WorkItem } from "@/types/domain";
import { cx, plural } from "@/utils/format";
import { diffDays, myDayStats, teamStats } from "@/pages/work/workStats";

/* ==========================================================================
   Página inicial: tarefas do dia (todos da equipe) e tarefas da equipe (gestão)
   ========================================================================== */
const LIMIT = 6;

/** Tarefas do dia da pessoa logada, com marcação direto na página inicial. */
export function MyDayCard({ items, today, onChange }: { items: WorkItem[]; today: string; onChange: (items: WorkItem[]) => void }) {
  const toast = useToast();
  const s = myDayStats(items, today);
  const pending = [...s.late, ...s.dueToday];
  const doneTotal = s.doneToday.length + s.dueToday.length;
  const shown = [...pending, ...s.doneToday].slice(0, LIMIT);
  const hidden = pending.length + s.doneToday.length - shown.length;

  async function toggle(it: WorkItem) {
    const done_at = it.done_at ? null : new Date().toISOString();
    onChange(items.map((x) => (x.id === it.id ? { ...x, done_at } : x)));
    try { await api.updateWorkItem(it.id, { done_at }); if (done_at) toast("Tarefa feita."); }
    catch (e) { onChange(items.map((x) => (x.id === it.id ? it : x))); toast((e as Error).message, "error"); }
  }

  return (
    <Card title="Tarefas do dia" count={pending.length || undefined}
      action={<Link to="/minhas-tarefas" className="link">Abrir</Link>}>
      <div className="wsum">
        <span className="wsum__item"><b>{s.dueToday.length}</b> para hoje</span>
        <span className={cx("wsum__item", s.late.length > 0 && "is-danger")}><b>{s.late.length}</b> {s.late.length === 1 ? "atrasada" : "atrasadas"}</span>
        <span className="wsum__item is-success"><b>{s.doneToday.length}</b> {s.doneToday.length === 1 ? "feita hoje" : "feitas hoje"}</span>
        {s.fromLead > 0 && <span className="wsum__item is-brand"><Icon name="user" size={12} /> {plural(s.fromLead, "da liderança", "da liderança")}</span>}
      </div>
      {doneTotal > 0 && <ProgressBar value={(s.doneToday.length / doneTotal) * 100} label="Tarefas de hoje feitas" thin />}
      {shown.length === 0 ? (
        <EmptyState compact icon="checkCircle" title="Nada pendente para hoje."
          text={s.next7 ? `${plural(s.next7, "tarefa", "tarefas")} nos próximos 7 dias.` : "Planeje o seu dia em Minhas tarefas."} />
      ) : (
        <ul className="mw-items wday">
          {shown.map((it) => {
            const late = !it.done_at && it.due_date < today;
            return (
              <li key={it.id} className={cx("mw-item", it.done_at && "is-done", late && "is-late", it.assigned_by && "is-assigned")}>
                <button type="button" className={cx("mw-check", it.done_at && "is-on")} aria-pressed={!!it.done_at}
                  aria-label={it.done_at ? `Desmarcar “${it.title}”` : `Marcar “${it.title}” como feita`} onClick={() => toggle(it)}>
                  {it.done_at && <Icon name="check" size={14} />}
                </button>
                <span className="mw-item__main">
                  <span className="mw-item__title">{it.title}</span>
                  <span className="mw-item__meta">
                    {it.assigned_by && <span className="mw-from">Da liderança · {it.assigned_by.name}</span>}
                    {late && <span className="mw-late">{plural(diffDays(it.due_date, today), "dia", "dias")} de atraso</span>}
                    {(it.project_code || it.project_name) && <span>{[it.project_code ?? it.project_name, it.step_name].filter(Boolean).join(" · ")}</span>}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <Link to="/minhas-tarefas" className="link wday__more">Ver mais {hidden}</Link>}
    </Card>
  );
}

/** Tarefas atribuídas à equipe: feitas, em aberto e em atraso por pessoa. */
export function TeamTasksCard({ items, today }: { items: WorkItem[]; today: string }) {
  const navigate = useNavigate();
  const s = teamStats(items, today);
  return (
    <Card title="Tarefas da equipe" count={s.open || undefined}
      action={<Link to="/minhas-tarefas?aba=equipe" className="link">Ver todas</Link>}>
      {items.length === 0 ? (
        <EmptyState compact icon="users" title="Nenhuma tarefa atribuída à equipe."
          text="Agende atividades fora do cronograma e acompanhe quem já fez."
          action={<Button size="sm" icon="plus" onClick={() => navigate("/minhas-tarefas?aba=equipe&nova=1")}>Nova tarefa</Button>} />
      ) : (
        <>
          <div className="tsum">
            <div className="tsum__kpi"><span className="label">Em aberto</span><b>{s.open}</b></div>
            <div className={cx("tsum__kpi", s.today > 0 && "is-brand")}><span className="label">Para hoje</span><b>{s.today}</b></div>
            <div className={cx("tsum__kpi", s.late > 0 && "is-danger")}><span className="label">Em atraso</span><b>{s.late}</b></div>
            <div className="tsum__kpi"><span className="label">No prazo</span><b>{s.onTimePct == null ? "—" : `${s.onTimePct}%`}</b>
              <span className="subtext">{plural(s.done30, "feita", "feitas")} em 30 dias</span></div>
          </div>
          <ul className="tsum__people">
            {s.people.slice(0, LIMIT).map((r) => (
              <li key={r.p.id}>
                <Link to="/minhas-tarefas?aba=equipe" className="tsum__person">
                  <Avatar name={r.p.name} src={r.p.avatar_url} size="sm" />
                  <span className="tsum__name truncate">{r.p.name}</span>
                  <span className="tsum__bar"><ProgressBar value={r.total ? (r.done / r.total) * 100 : 0} label={`Concluídas por ${r.p.name}`} thin tone={r.late ? "danger" : undefined} /></span>
                  <span className={cx("tsum__state", r.late > 0 ? "is-danger" : r.open === 0 ? "is-success" : undefined)}>
                    {r.late > 0 ? `${r.late} em atraso` : r.open === 0 ? "Tudo feito" : `${r.open} em aberto`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** Carrega as tarefas do dia (e as da equipe, para gestão). */
export function useWorkSummary(isManager: boolean) {
  const [mine, setMine] = useState<WorkItem[] | null>(null);
  const [team, setTeam] = useState<WorkItem[] | null>(null);
  useEffect(() => {
    let live = true;
    api.listWorkItems().then((x) => live && setMine(x ?? [])).catch(() => live && setMine([]));
    if (isManager) api.teamWorkItems().then((x) => live && setTeam(x ?? [])).catch(() => live && setTeam([]));
    return () => { live = false; };
  }, [isManager]);
  return { mine, setMine, team };
}

