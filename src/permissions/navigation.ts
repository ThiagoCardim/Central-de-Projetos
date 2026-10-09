import type { IconName } from "@/components/ui/Icon";
import type { Capability } from "./index";

export interface NavItem {
  key: string;
  label: string;
  to: string;
  icon: IconName;
  requires: Capability;
  /** Etapa em que a tela será entregue. Itens com stage aparecem desabilitados. */
  stage?: string;
  mobile?: boolean;
}

export interface NavSection { title?: string; items: NavItem[] }

export const NAVIGATION: NavSection[] = [
  {
    items: [
      { key: "home", label: "Início", to: "/", icon: "home", requires: "home", mobile: true },
      { key: "mywork", label: "Minhas tarefas", to: "/minhas-tarefas", icon: "checkCircle", requires: "staff", mobile: true },
      { key: "projects", label: "Projetos", to: "/projetos", icon: "folder", requires: "staff", mobile: true },
      { key: "cs", label: "Customer Success", to: "/cs", icon: "headset", requires: "csDesk", mobile: true },
      { key: "clients", label: "Clientes", to: "/clientes", icon: "briefcase", requires: "oversight" },
      { key: "schedule", label: "Cronograma", to: "/cronograma", icon: "calendar", requires: "staff", mobile: true },
      { key: "team", label: "Equipe", to: "/equipe", icon: "users", requires: "oversight" },
      { key: "performance", label: "Performance", to: "/performance", icon: "trend", requires: "performance" },
      { key: "approvals", label: "Aprovações", to: "/aprovacoes", icon: "seal", requires: "approvals" },
    ],
  },
  {
    title: "Administração",
    items: [
      { key: "access", label: "Controle de Acessos", to: "/acessos", icon: "shield", requires: "manageUsers", mobile: true },
      { key: "intake", label: "Central de Entrada", to: "/entrada", icon: "inbox", requires: "viewIntake" },
      { key: "templates", label: "Serviços e Cronogramas", to: "/servicos", icon: "layers", requires: "manager" },
      { key: "automations", label: "Automações", to: "/automacoes", icon: "zap", requires: "manager" },
      { key: "settings", label: "Configurações", to: "/configuracoes", icon: "sliders", requires: "manageUnit" },
      { key: "units", label: "Unidades", to: "/unidades", icon: "building", requires: "manageUnit", mobile: true },
      { key: "reports", label: "Relatórios", to: "/relatorios", icon: "chart", requires: "manager", stage: "Futuro" },
    ],
  },
  {
    title: "Ajuda",
    items: [
      { key: "help", label: "Preciso de ajuda", to: "/ajuda", icon: "chat", requires: "client", mobile: true },
      { key: "faq", label: "Dúvidas frequentes", to: "/duvidas", icon: "help", requires: "home", mobile: true },
    ],
  },
];
