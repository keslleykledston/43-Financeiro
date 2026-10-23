import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { executionQueue } from "@/modules/payables/service";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";

const br = (d: string) => d.split("-").reverse().join("/");

export default async function Execucao() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a pagar.</Callout>;
  const q = await executionQueue(db, ctx.user.id, ctx.current.id);
  const total = q.reduce((s, r) => s + r.openCents, 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Fila de execução" description={`${ctx.current.name} · contas aprovadas, a pagar no banco, por vencimento.`}
        actions={<div className="flex gap-2"><AppLink href="/contas-a-pagar" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas</AppLink>{can(role, "payables.export") && <a href="/contas-a-pagar/exportar?fila=1" className={buttonClass("outline")}>Exportar CSV</a>}</div>} />
      <Callout tone="info">Lista de apoio para quem executa os pagamentos <strong>no Cora, à mão</strong>. Depois de pagar, abra a conta e <strong>registre a baixa</strong> com a data e o protocolo do comprovante. O sistema não paga nada.</Callout>
      <SectionCard title={`${q.length} conta(s) · total ${(total / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`}>
        {q.length === 0 ? <EmptyState title="Nada aprovado para pagar" description="Quando contas forem aprovadas, elas aparecem aqui." /> : (
          <ul className="divide-y divide-border">
            {q.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div><AppLink href={`/contas-a-pagar/${r.id}`} className="font-medium hover:underline">{r.vendorName}</AppLink>
                  <p className="text-xs text-muted-foreground">{r.description}{r.documentNumber ? ` · doc. ${r.documentNumber}` : ""} · vence {br(r.dueDate)}</p></div>
                <span className="flex items-center gap-3"><Money cents={r.openCents} />{r.overdueDays > 0 ? <StatusPill tone="negative">{r.overdueDays} dia(s) de atraso</StatusPill> : <StatusPill tone="info">No prazo</StatusPill>}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
