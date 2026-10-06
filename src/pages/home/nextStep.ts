// Decide o "próximo passo" exibido no topo da Home.
// Ordem de prioridade: atraso > equipe a atribuir > vence hoje > bloqueio > pendência do cliente > rotina.
import type { HomeDashboard, Permissions } from "@/types/domain";
import { plural } from "@/utils/format";
import type { IconName } from "@/components/ui/Icon";
import type { Tone } from "@/utils/format";

export interface NextStep {
  tone: Tone;
  icon: IconName;
  headline: string;
  context?: string;
  action?: { label: string; to?: string; disabledReason?: string };
}

export function computeNextStep(d: HomeDashboard, perms: Permissions | null): NextStep {
  // Cliente
  if (d.client) {
    const projects = d.client.projects;
    if (projects.length === 0) {
      return { tone: "neutral", icon: "clock", headline: "Seu projeto está sendo preparado.",
        context: "Assim que a equipe for definida, as etapas e prazos aparecerão aqui." };
    }
    const pending = projects.reduce((n, p) => n + p.pending_from_client, 0);
    if (pending > 0) {
      return { tone: "warning", icon: "alert", headline: `Há ${plural(pending, "etapa aguardando você", "etapas aguardando você")}.`,
        context: "Envie as informações solicitadas para o cronograma seguir no prazo." };
    }
    const p = projects[0];
    const current = p.services.map((s) => s.current_step).find(Boolean);
    return {
      tone: "brand", icon: "target",
      headline: current ? `Seu projeto está na etapa ${current.name}.` : "Seu projeto está em andamento.",
      context: p.forecast_end ? `Previsão de conclusão: ${new Date(`${p.forecast_end}T12:00:00`).toLocaleDateString("pt-BR")}.` : undefined,
    };
  }

  const ops = d.operations;
  const mine = d.my_work;

  if (ops && ops.counts.tasks_overdue > 0) {
    const worst = ops.alerts.find((a) => a.is_overdue);
    return {
      tone: "danger", icon: "alert",
      headline: `${plural(ops.counts.tasks_overdue, "etapa atrasada", "etapas atrasadas")} em ${plural(ops.counts.projects_at_risk, "projeto", "projetos")}.`,
      context: worst ? `Mais crítica: ${worst.task_name}, ${worst.project_name} (${worst.overdue_days} ${worst.overdue_days === 1 ? "dia" : "dias"}).` : undefined,
      action: { label: "Ver etapas atrasadas", to: "/cronograma?filtro=overdue" },
    };
  }
  if (ops && ops.awaiting_team.length > 0) {
    const p = ops.awaiting_team[0];
    return {
      tone: "brand", icon: "userPlus",
      headline: ops.awaiting_team.length === 1
        ? `Novo projeto aguardando equipe: ${p.client_name}.`
        : `${ops.awaiting_team.length} projetos aguardando equipe.`,
      context: `${p.name}${p.city ? `, ${p.city}` : ""} — ${p.services.join(", ") || "serviços a confirmar"}.`,
      action: ops.awaiting_team.length === 1
        ? { label: "Revisar e atribuir equipe", to: `/projetos/${p.id}?acao=equipe` }
        : { label: "Ver projetos aguardando equipe", to: "/projetos?status=awaiting_team_assignment" },
    };
  }
  if (ops && perms?.can_distribute && ops.counts.awaiting_allocation > 0) {
    return {
      tone: "brand", icon: "building",
      headline: `${plural(ops.counts.awaiting_allocation, "projeto aguardando distribuição", "projetos aguardando distribuição")}.`,
      context: "Defina qual unidade executa cada projeto para liberar a atribuição de equipe.",
      action: { label: "Distribuir projetos", to: "/projetos?status=awaiting_allocation" },
    };
  }
  if (d.admin && d.admin.intake.errors > 0 && perms?.can_view_intake) {
    return {
      tone: "warning", icon: "inbox",
      headline: `${plural(d.admin.intake.errors, "entrada do CRM precisa", "entradas do CRM precisam")} de revisão.`,
      context: "Corrija os dados e reprocesse para criar o projeto.",
      action: { label: "Abrir Central de Entrada", to: "/entrada" },
    };
  }
  if (mine && mine.counts.overdue > 0) {
    const t = mine.tasks.find((x) => x.is_overdue);
    return { tone: "danger", icon: "alert",
      headline: `Você tem ${plural(mine.counts.overdue, "etapa atrasada", "etapas atrasadas")}.`,
      context: t ? `Comece por ${t.task_name}, ${t.project_name}.` : undefined };
  }
  if (mine && mine.counts.due_today > 0) {
    const t = mine.tasks.find((x) => x.due_in_days === 0);
    return { tone: "brand", icon: "flag",
      headline: `${plural(mine.counts.due_today, "entrega vence", "entregas vencem")} hoje.`,
      context: t ? `${t.task_name}, ${t.project_name}.` : undefined };
  }
  if (ops && ops.counts.tasks_blocked > 0) {
    return { tone: "warning", icon: "pause",
      headline: `${plural(ops.counts.tasks_blocked, "etapa bloqueada", "etapas bloqueadas")} na unidade.`,
      context: "Verifique dependências e terceiros para destravar o cronograma." };
  }
  if (ops && ops.counts.tasks_unassigned > 0) {
    return { tone: "warning", icon: "user",
      headline: `${plural(ops.counts.tasks_unassigned, "etapa sem responsável", "etapas sem responsável")}.`,
      context: "Defina quem conduz cada etapa para que os prazos sejam acompanhados." };
  }
  if (mine && mine.counts.due_next_7 > 0) {
    return { tone: "neutral", icon: "calendar",
      headline: `${plural(mine.counts.due_next_7, "entrega próxima", "entregas próximas")} nos próximos 7 dias.`,
      context: "Nada atrasado. Mantenha o ritmo." };
  }
  if (d.admin && perms?.can_manage_users && d.admin.users.active <= 1) {
    return { tone: "brand", icon: "userPlus", headline: "Convide sua equipe para começar.",
      context: "Cadastre líderes e colaboradores (CLT ou PJ) para receber os primeiros projetos.",
      action: { label: "Convidar usuários", to: "/acessos" } };
  }
  if (ops && ops.counts.projects_active === 0) {
    return { tone: "neutral", icon: "inbox", headline: "Nenhum projeto em andamento.",
      context: "Quando uma venda for fechada no CRM, o projeto aparecerá aqui para distribuição e equipe." };
  }
  return { tone: "success", icon: "checkCircle", headline: "Tudo em dia.",
    context: "Nenhum atraso, bloqueio ou pendência que exija sua ação agora." };
}
