import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { ADJ_KINDS, ADJ_LABEL, listCompetence } from "@/modules/billing/adjustments";
import { addMonths } from "@/modules/billing/calendar";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { addAdjustmentAction, removeAdjustmentAction } from "./actions";

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const OK: Record<string, string> = { lancado: "Ajuste lançado. Atualize a prévia do lote para aplicar o novo valor.", removido: "Ajuste removido. Atualize a prévia do lote." };

export default async function Ajustes({ searchParams }: { searchParams: Promise<{ mes?: string; erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "billing.read")) return <Callout tone="warning">Seu papel não tem acesso aos ajustes de cobrança.</Callout>;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
  const mes = sp.mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes) ? sp.mes : addMonths(today.slice(0, 7), -1); // competência = mês anterior ao atual
  const [y, m] = mes.split("-").map(Number);
  const rows = await listCompetence(db, ctx.user.id, ctx.current.id, mes);
  const write = can(role, "billing.write");
  const totalBase = rows.reduce((s, r) => s + r.baseCents, 0), totalAdj = rows.reduce((s, r) => s + r.adjustmentCents, 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Ajustes da competência" description={`${ctx.current.name} · excedente, acréscimo e desconto lançados à mão.`}
        actions={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}>Lotes</AppLink>} />
      <Callout tone="info">O <strong>excedente</strong> (por exemplo, o da K3G Call) é calculado em outro sistema e <strong>lançado aqui</strong>, por contrato. O valor da cobrança no lote fica <strong>valor do contrato + ajustes</strong>. Depois de lançar, abra o lote e use <strong>Atualizar prévia</strong>. Quando o lote é aprovado, os ajustes ficam travados.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}

      <nav aria-label="Competência" className="flex items-center justify-between gap-2">
        <AppLink href={`/faturamento/ajustes?mes=${addMonths(mes, -1)}`} className={buttonClass("outline", "sm")}><ChevronLeft className="size-4" aria-hidden /> {MESES[(m + 10) % 12]}</AppLink>
        <h2 className="text-lg font-semibold" aria-live="polite">Competência de {MESES[m - 1]} de {y}</h2>
        <AppLink href={`/faturamento/ajustes?mes=${addMonths(mes, 1)}`} className={buttonClass("outline", "sm")}>{MESES[m % 12]} <ChevronRight className="size-4" aria-hidden /></AppLink>
      </nav>

      <section aria-label="Resumo" className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Contratos</p><p className="text-xl font-semibold">{rows.length}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Valor dos contratos</p><Money cents={totalBase} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Ajustes lançados</p><Money cents={totalAdj} className="text-xl font-semibold" /></div>
      </section>

      <SectionCard title="Contratos faturáveis na competência">
        {rows.length === 0 ? <EmptyState icon={SlidersHorizontal} title="Nenhum contrato faturável nesta competência" description="Só contratos aprovados e ativos, de clientes ativos e dentro da vigência, aparecem aqui." action={<AppLink href="/contratos" className={buttonClass("outline")}>Contratos</AppLink>} /> : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.contractId} id={`c-${r.contractId}`} className="py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><p className="font-medium">{r.customerName}</p><p className="text-xs text-muted-foreground">{r.description}</p></div>
                  <span className="flex items-center gap-3 text-right">
                    <span><span className="block text-xs text-muted-foreground">Contrato</span><Money cents={r.baseCents} /></span>
                    <span><span className="block text-xs text-muted-foreground">Ajustes</span><Money cents={r.adjustmentCents} /></span>
                    <span><span className="block text-xs text-muted-foreground">Cobrança</span><Money cents={r.totalCents} className="font-semibold" /></span>
                    {r.locked ? <StatusPill tone="positive">Lote aprovado</StatusPill> : r.chargeStatus === "previa" ? <StatusPill tone="info">Em prévia</StatusPill> : null}
                  </span>
                </div>
                {r.adjustments.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {r.adjustments.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-1.5 text-xs">
                        <span><strong>{ADJ_LABEL[a.kind]}</strong> · {a.description}</span>
                        <span className="flex items-center gap-2"><Money cents={a.kind === "desconto" ? -a.amountCents : a.amountCents} />
                          {write && !r.locked && <form action={removeAdjustmentAction}><input type="hidden" name="id" value={a.id} /><input type="hidden" name="competence" value={mes} /><input type="hidden" name="contractId" value={r.contractId} /><button className={buttonClass("ghost", "sm")}>Remover</button></form>}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {write && !r.locked && (
                  <form action={addAdjustmentAction} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="contractId" value={r.contractId} /><input type="hidden" name="competence" value={mes} />
                    <div><label htmlFor={`k-${r.contractId}`} className="mb-1 block text-xs font-medium">Tipo</label><select id={`k-${r.contractId}`} name="kind" defaultValue="excedente" className={selectClass}>{ADJ_KINDS.map((k) => <option key={k} value={k}>{ADJ_LABEL[k]}</option>)}</select></div>
                    <div className="min-w-48 flex-1"><label htmlFor={`d-${r.contractId}`} className="mb-1 block text-xs font-medium">Descrição</label><input id={`d-${r.contractId}`} name="description" required minLength={2} maxLength={120} defaultValue="Excedente" className={inputClass} /></div>
                    <div><label htmlFor={`v-${r.contractId}`} className="mb-1 block text-xs font-medium">Valor (R$)</label><input id={`v-${r.contractId}`} name="amount" inputMode="decimal" required placeholder="0,00" className={`${inputClass} w-32`} /></div>
                    <button className={buttonClass("outline", "sm")}>Lançar ajuste</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
