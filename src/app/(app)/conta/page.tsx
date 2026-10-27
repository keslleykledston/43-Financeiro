import { requireContext } from "@/lib/security/context";
import { PageHeader, SectionCard } from "@/components/k3g/primitives";
import { buttonClass } from "@/components/k3g/button";
import { PasswordForm } from "./password-form";
import { revokeSessionsAction } from "./actions";
import { TwoFactor } from "./two-factor";
import { db } from "@/lib/db";
import { twoFactorStatus } from "@/modules/identity/twofactor";

export default async function Conta() {
  const ctx = await requireContext();
  const tf = await twoFactorStatus(db, ctx.user.id);
  const recommended = ctx.companies.some((c) => c.role === "diretoria" || c.role === "admin_tecnico");
  return (
    <div className="space-y-5">
      <PageHeader title="Minha conta" description={ctx.user.email ?? undefined} />
      <SectionCard title="Trocar senha"><PasswordForm /></SectionCard>
      <SectionCard title="Verificação em duas etapas"><TwoFactor enabled={tf.enabled} recoveryLeft={tf.recoveryLeft} recommended={recommended} /></SectionCard>
      <SectionCard title="Sessões">
        <form action={revokeSessionsAction} className="max-w-sm space-y-3">
          <p className="text-sm text-muted-foreground">Encerra o acesso deste usuário em todos os aparelhos, inclusive este. Trocar a senha faz o mesmo.</p>
          <button className={buttonClass("outline")}>Sair em todos os dispositivos</button>
        </form>
      </SectionCard>
    </div>
  );
}
