import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listReceipts } from "@/modules/insights/service";
import { METHOD_LABEL, type Method } from "@/modules/receivables/status";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";

const br = (d: string) => d.split("-").reverse().join("/");

export default async function Recebimentos({ searchParams }: { searchParams: Promise<{ mes?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "receivables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a receber.</Callout>;
  const mes = sp.mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes) ? sp.mes : new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" }).slice(0, 7);
  const r = await listReceipts(db, ctx.user.id, ctx.current.id, mes);
  return (
    <div className="space-y-5">
      <PageHeader title={`Recebimentos de ${mes.slice(5, 7)}/${mes.slice(0, 4)}`} description={`${ctx.current.name} · os pagamentos que compõem o “Recebido no mês” do painel.`}
        actions={<AppLink href="/" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Painel</AppLink>} />
      <Callout tone="info">Total dos pagamentos <strong>ativos</strong>: <Money cents={r.totalCents} className="font-semibold" />. Estornos aparecem na lista, mas não entram na soma.</Callout>
      {r.truncated && <Callout tone="warning">Mostrando os 500 pagamentos mais recentes do mês. O total acima considera todos.</Callout>}
      <SectionCard title="Pagamentos">
        {r.items.length === 0 ? <EmptyState title="Nenhum pagamento neste mês" description="Registre baixas em Contas a receber ou concilie o extrato." /> : (
          <ul className="divide-y divide-border text-sm">
            {r.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div><AppLink href={`/contas-a-receber/${p.chargeId}`} className={p.status === "estornado" ? "text-muted-foreground line-through" : "font-medium hover:underline"}>{p.customerName}</AppLink>
                  <p className="text-xs text-muted-foreground">{br(p.paidAt)} · {METHOD_LABEL[p.method as Method] ?? p.method}{p.interestCents > 0 ? ` · inclui juros/multa de ${(p.interestCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}{p.discountCents > 0 ? ` · desconto de ${(p.discountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}</p></div>
                <span className="flex items-center gap-2"><Money cents={p.amountCents} /><StatusPill tone={p.status === "ativo" ? "positive" : "neutral"}>{p.status === "ativo" ? "Ativo" : "Estornado"}</StatusPill></span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
