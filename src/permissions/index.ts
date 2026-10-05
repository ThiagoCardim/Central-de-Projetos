// Permissões no frontend: SOMENTE para exibir/ocultar interface.
// A fonte de verdade é o banco (private.can_* + RLS); toda ação é revalidada lá.
import type { Permissions, UserRole } from "@/types/domain";

export type Capability =
  | "home"
  | "manageUsers"
  | "manageUnit"
  | "manageAllUnits"
  | "manageTemplates"
  | "viewIntake"
  | "distribute"
  | "manager"
  | "staff";

export function can(perms: Permissions | null, cap: Capability): boolean {
  if (!perms) return false;
  switch (cap) {
    case "home": return true;
    case "manageUsers": return perms.can_manage_users;
    case "manageUnit": return perms.can_manage_tenant;
    case "manageAllUnits": return perms.can_manage_tenants;
    case "manageTemplates": return perms.can_manage_templates;
    case "viewIntake": return perms.can_view_intake;
    case "distribute": return perms.can_distribute;
    case "manager": return perms.is_manager;
    case "staff": return perms.is_staff;
  }
}

const RANK: Record<UserRole, number> = { client: 0, collaborator: 1, leader: 2, unit_admin: 3, global_admin: 4 };

/** Papéis que o usuário logado pode atribuir (o banco aplica a mesma regra em can_grant_role). */
export function grantableRoles(perms: Permissions | null, targetIsHeadquarters: boolean): UserRole[] {
  if (!perms?.can_manage_users) return [];
  const mine = RANK[perms.role];
  return (Object.keys(RANK) as UserRole[]).filter((r) => {
    if (r === "global_admin") return perms.role === "global_admin" && targetIsHeadquarters;
    return RANK[r] <= mine;
  });
}
