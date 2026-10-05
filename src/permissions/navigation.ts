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
      { key: "projects", label: "Projetos", to: "/projetos", icon: "folder", requires: "staff", stage: "Etapa 2" },
      { key: "clients", label: "Clientes", to: "/clientes", icon: "briefcase", requires: "manager", stage: "Etapa 2" },
      { key: "schedule", label: "Cronograma", to: "/cronograma", icon: "calendar", requires: "staff", stage: "Etapa 3" },
      { key: "team", label: "Equipe", to: "/equipe", icon: "users", requires: "manager", stage: "Etapa 2" },
    ],
  },
  {
    title: "Administração",
    items: [
      { key: "access", label: "Controle de Acessos", to: "/acessos", icon: "shield", requires: "manageUsers", mobile: true },
      { key: "intake", label: "Central de Entrada", to: "/entrada", icon: "inbox", requires: "viewIntake", stage: "Etapa 2" },
      { key: "templates", label: "Serviços e Cronogramas", to: "/servicos", icon: "layers", requires: "manageTemplates", stage: "Etapa 3" },
      { key: "units", label: "Unidades", to: "/unidades", icon: "building", requires: "manageUnit", mobile: true },
      { key: "reports", label: "Relatórios", to: "/relatorios", icon: "chart", requires: "manager", stage: "Futuro" },
    ],
  },
];
