import { AppLink } from "./app-link";
import { cn } from "@/lib/utils";
import { can, type Role } from "@/modules/identity/permissions";

export type SettingsTab = "empresa" | "usuarios" | "despesas" | "atividades";

/** Navegação interna de Configurações (o item do menu lateral). Só mostra o que o papel pode abrir. */
export function SettingsTabs({ role, current }: { role: Role; current: SettingsTab }) {
  const items: { id: SettingsTab; label: string; href: string; ok: boolean }[] = [
    { id: "empresa", label: "Empresa", href: "/empresa", ok: can(role, "company.manage") },
    { id: "usuarios", label: "Usuários e acessos", href: "/configuracao?aba=usuarios", ok: can(role, "members.read") },
    { id: "despesas", label: "Despesas", href: "/despesas-cadastros", ok: can(role, "payables.manage") || can(role, "partners.manage") },
    { id: "atividades", label: "Registro de atividades", href: "/auditoria", ok: can(role, "audit.read") },
  ];
  return (
    <nav aria-label="Configurações" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
      {items.filter((i) => i.ok).map((i) => (
        <AppLink key={i.id} href={i.href} aria-current={current === i.id ? "page" : undefined}
          className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", current === i.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{i.label}</AppLink>
      ))}
    </nav>
  );
}
