import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getImport } from "@/modules/contracts/import";
import { STATUS_LABEL, type ContractStatus } from "@/modules/contracts/service";
import { formatDate, formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { decideImportAction } from "../actions";

const TONE: Record<ContractStatus, StatusTone> = { rascunho: "info", ativo: "positive", suspenso: "warning", encerrado: "neutral" };

export default async function Lote({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.read")) return <Callout tone="warning">Seu papel não tem acesso a contratos.</Callout>;
  const lote = await getImport(db, ctx.user.id, ctx.current.id, id);
  if (!lote) notFound();
  const pendentes = lote.items.filter((i) => i.status === "rascunho" && i.lastVersionState === "pendente").length;
  const canApprove = can(role, "contracts.approve");
  return (
    <div className="max-w-3xl space-y-5">
      <AppLink href="/contratos/importar" className="text-sm text-primary">← Importar contratos</AppLink>
      <PageHeader title="Lote de importação" description={`${formatDateTime(lote.createdAt)} · ${lote.items.length} contrato(s) · ${lote.summary.customersCreated} cliente(s) criado(s) como cadastro local`} />
      {sp.erro && <Callout tone="warning" role="alert">{sp.erro}</Callout>}
      {pendentes > 0 && (
        <SectionCard title={`Aprovação do lote (${pendentes} pendente(s))`}>
          {canApprove ? (
            <form action={decideImportAction} className="space-y-3">
              <input type="hidden" name="importId" value={lote.id} />
              <label htmlFor="note" className="block text-sm font-medium">Observação (opcional)</label>
              <input id="note" name="note" maxLength={500} className={inputClass} />
              <div className="flex flex-wrap gap-2">
                <button name="decision" value="aprovar" className={buttonClass("success")}>Aprovar {pendentes} contrato(s)</button>
                <button name="decision" value="rejeitar" className={buttonClass("danger")}>Rejeitar o lote</button>
              </div>
              <p className="text-xs text-muted-foreground">Quem importou ou editou os contratos não pode aprová-los (exige outro gerente ou a diretoria). Aprovar ativa todos de uma vez; a cobrança só nasce de contrato ativo de cliente ativo.</p>
            </form>
          ) : <p className="text-sm text-muted-foreground">Aguardando aprovação de um gerente ou da diretoria.</p>}
        </SectionCard>
      )}
      <ul className="divide-y divide-border rounded-lg border bg-card text-sm">
        {lote.items.map((i) => (
          <li key={i.id}>
            <AppLink href={`/contratos/${i.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-accent">
              <div className="min-w-0">
                <p className="truncate font-medium">{i.customerName}</p>
                <p className="truncate text-muted-foreground">{i.description} · vence dia {i.dueDay} · desde {formatDate(i.startAt)}{i.endAt ? ` até ${formatDate(i.endAt)}` : ""}{i.commissionPartner ? ` · comissão ${i.commissionPartner}` : ""}</p>
              </div>
              <div className="flex items-center gap-2"><StatusPill tone={TONE[i.status as ContractStatus]}>{i.status === "rascunho" ? (i.lastVersionState === "rejeitada" ? "Rejeitado" : "Aguardando") : STATUS_LABEL[i.status as ContractStatus]}</StatusPill><Money cents={i.amountCents} className="font-semibold" /></div>
            </AppLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
