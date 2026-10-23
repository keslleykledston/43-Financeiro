export type Role = "admin_tecnico" | "diretoria" | "gerente" | "assistente" | "contabilidade";
export type Permission = "members.read" | "members.invite" | "members.remove" | "finance.read" | "audit.read" | "crm.read" | "crm.write" | "crm.export" | "integrations.manage" | "crm.reactivate" | "contracts.read" | "contracts.write" | "contracts.approve" | "billing.read" | "billing.write" | "billing.approve";

// Admin técnico gere acessos mas NÃO lê dados financeiros por padrão.
const MAP: Record<Role, Permission[]> = {
  admin_tecnico: ["members.read", "members.invite", "members.remove", "audit.read", "integrations.manage"],
  diretoria: ["members.read", "members.invite", "members.remove", "finance.read", "audit.read", "crm.read", "crm.write", "crm.export", "integrations.manage", "crm.reactivate", "contracts.read", "contracts.write", "contracts.approve", "billing.read", "billing.write", "billing.approve"],
  gerente: ["members.read", "finance.read", "crm.read", "crm.write", "crm.export", "crm.reactivate", "contracts.read", "contracts.write", "contracts.approve", "billing.read", "billing.write", "billing.approve"],
  assistente: ["finance.read", "crm.read", "crm.write", "contracts.read", "contracts.write", "billing.read", "billing.write"],
  contabilidade: ["finance.read", "crm.read", "crm.export", "contracts.read", "billing.read"],
};

export const can = (role: Role, perm: Permission) => MAP[role].includes(perm);

/** Quem pode conceder qual papel: diretoria não cria admin técnico. */
export const canGrant = (actor: Role, target: Role) =>
  actor === "admin_tecnico" || (actor === "diretoria" && target !== "admin_tecnico");

export const ROLE_LABEL: Record<Role, string> = {
  admin_tecnico: "Admin técnico", diretoria: "Diretoria", gerente: "Gerente", assistente: "Assistente", contabilidade: "Contabilidade",
};
