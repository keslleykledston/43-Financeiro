import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole, listMembers } from "@/modules/identity/service";
import { can, canGrant, ROLE_LABEL, type Role } from "@/modules/identity/permissions";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { InviteForm } from "./invite-form";
import { removeAction } from "./actions";

const ALL: Role[] = ["diretoria", "gerente", "assistente", "contabilidade", "admin_tecnico"];

export default async function Ajustes() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "members.read")) {
    return <section className="rounded-lg border bg-card p-8 text-center"><h1 className="text-xl font-semibold">Ajustes</h1><p className="mt-2 text-muted-foreground">Seu papel não tem acesso à gestão de usuários desta empresa.</p></section>;
  }
  const members = await listMembers(db, ctx.user.id, ctx.current.id);
  const grantable = ALL.filter((r) => canGrant(role, r));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Usuários e acessos</h1><p className="text-sm text-muted-foreground">{ctx.current.name} · seu papel: {ROLE_LABEL[role]}</p></div>
        <div className="flex flex-wrap gap-2">
        {can(role, "company.manage") && <AppLink href="/empresa" className={buttonClass("outline", "sm")}>Dados da empresa</AppLink>}
        {can(role, "audit.read") && <AppLink href="/auditoria" className={buttonClass("outline", "sm")}>Registro de atividades</AppLink>}
        </div>
      </div>
      {can(role, "members.invite") && (
        <section className="rounded-lg border bg-card p-5"><h2 className="mb-3 font-semibold">Convidar usuário</h2><InviteForm roles={grantable} /></section>
      )}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">Membros ({members.length})</h2>
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.membershipId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0"><p className="truncate font-medium">{m.name}</p><p className="truncate text-muted-foreground">{m.email} · {ROLE_LABEL[m.role]}</p></div>
              {can(role, "members.remove") && m.userId !== ctx.user.id && canGrant(role, m.role) && (
                <form action={removeAction}><input type="hidden" name="membershipId" value={m.membershipId} /><button className="rounded-lg px-3 py-1.5 text-negative-foreground ring-1 ring-negative/30">Remover</button></form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
