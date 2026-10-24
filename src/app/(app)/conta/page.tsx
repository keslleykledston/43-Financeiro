import { requireContext } from "@/lib/security/context";
import { PageHeader, SectionCard } from "@/components/k3g/primitives";
import { buttonClass } from "@/components/k3g/button";
import { PasswordForm } from "./password-form";
import { revokeSessionsAction } from "./actions";

export default async function Conta() {
  const ctx = await requireContext();
  return (
    <div className="space-y-5">
      <PageHeader title="Minha conta" description={ctx.user.email ?? undefined} />
      <SectionCard title="Trocar senha"><PasswordForm /></SectionCard>
      <SectionCard title="Sessões">
        <form action={revokeSessionsAction} className="max-w-sm space-y-3">
          <p className="text-sm text-muted-foreground">Encerra o acesso deste usuário em todos os aparelhos, inclusive este. Trocar a senha faz o mesmo.</p>
          <button className={buttonClass("outline")}>Sair em todos os dispositivos</button>
        </form>
      </SectionCard>
    </div>
  );
}
