import { Landmark } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listAccounts } from "@/modules/banking/service";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { createAccountAction } from "./actions";

export default async function Conciliacao({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "bank.read")) return <Callout tone="warning">Seu papel não tem acesso à conciliação bancária.</Callout>;
  const accounts = await listAccounts(db, ctx.user.id, ctx.current.id);
  const manage = can(role, "bank.accounts");
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });

  return (
    <div className="space-y-5">
      <PageHeader title="Conciliação" description={`${ctx.current.name} · extratos e vínculo com cobranças.`} />
      <Callout tone="info">O sistema só <strong>lê</strong> o extrato que você importa (OFX ou CSV). Nada é enviado ao banco e nenhum pagamento é feito. Vincular um crédito a uma cobrança registra a baixa em Contas a receber e pode ser desfeito.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok === "conta" && <Callout tone="positive" role="status">Conta cadastrada.</Callout>}

      <SectionCard title="Contas bancárias">
        {accounts.length === 0 ? (
          <EmptyState icon={Landmark} title="Nenhuma conta cadastrada" description={manage ? "Cadastre a conta (um nome e o saldo inicial) e depois importe o extrato." : "Peça à diretoria ou ao gerente para cadastrar a conta bancária."} />
        ) : (
          <ul className="divide-y divide-border">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div>
                  <AppLink href={`/conciliacao/contas/${a.id}`} className="font-medium hover:underline">{a.name}</AppLink>
                  <p className="text-xs text-muted-foreground">{a.bank}{a.last4 ? ` · final ${a.last4}` : ""} · saldo inicial em {a.openingDate.split("-").reverse().join("/")} · {a.txCount} transação(ões)</p>
                </div>
                <span className="flex items-center gap-3 text-right">
                  <span><Money cents={a.balanceCents} className="font-semibold" /><span className="block text-xs text-muted-foreground">saldo pelo extrato</span></span>
                  {a.pendingCount > 0 ? <StatusPill tone="warning">{a.pendingCount} a conciliar</StatusPill> : <StatusPill tone="positive">Em dia</StatusPill>}
                  <AppLink href={`/conciliacao/contas/${a.id}`} className={buttonClass("outline", "sm")}>Abrir</AppLink>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {manage && (
        <SectionCard title="Nova conta">
          <form action={createAccountAction} className="grid max-w-3xl gap-4 sm:grid-cols-2">
            <div><label htmlFor="name" className="mb-1 block text-sm font-medium">Nome da conta</label><input id="name" name="name" required minLength={2} maxLength={60} placeholder="Ex.: Cora — K3G" className={inputClass} /></div>
            <div><label htmlFor="bank" className="mb-1 block text-sm font-medium">Banco</label><input id="bank" name="bank" required minLength={2} maxLength={40} placeholder="Cora, Caixa, Santander…" className={inputClass} /></div>
            <div><label htmlFor="last4" className="mb-1 block text-sm font-medium">Final da conta (4 dígitos, opcional)</label><input id="last4" name="last4" inputMode="numeric" pattern="\d{4}" maxLength={4} className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Serve só para conferir se o arquivo é da conta certa. Nunca digite o número completo.</p></div>
            <div><label htmlFor="openingBalance" className="mb-1 block text-sm font-medium">Saldo inicial (R$)</label><input id="openingBalance" name="openingBalance" inputMode="decimal" defaultValue="0,00" required className={inputClass} /></div>
            <div><label htmlFor="openingDate" className="mb-1 block text-sm font-medium">Data do saldo inicial</label><input id="openingDate" name="openingDate" type="date" defaultValue={today} required className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">O extrato importado deve começar depois desta data.</p></div>
            <div className="sm:col-span-2"><button className={buttonClass("primary")}>Cadastrar conta</button></div>
          </form>
        </SectionCard>
      )}
    </div>
  );
}
