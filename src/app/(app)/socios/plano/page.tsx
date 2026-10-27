import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { buildPlan } from "@/modules/expenses/plan";
import { todayManaus } from "@/modules/messaging/service";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { savePartnerPlanAction, saveSettingsAction } from "./actions";

const mes = (m: string) => `${m.slice(5)}/${m.slice(0, 4)}`;
const pct = (bps: number) => String(bps / 100).replace(".", ",");
const brl = (c: number) => formatBRL(c);
const neg = (c: number | null) => (c !== null && c < 0 ? "text-negative-foreground" : "");

export default async function Plano({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "partners.read")) return <Callout tone="warning">Seu papel não tem acesso ao plano de retiradas.</Callout>;
  const manage = can(role, "partners.manage");
  const v = await buildPlan(db, ctx.user.id, ctx.current.id, todayManaus());
  const { plan, settings } = v;
  const hasCash = settings.cashNowCents !== null;
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Plano de retiradas e lucro" description={`${ctx.current.name} · projeção dos próximos 12 meses`} actions={<AppLink href="/socios" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Sócios</AppLink>} />
      <Callout tone="info">É uma <strong>projeção para decidir</strong>, não o resultado contábil nem uma promessa. Ela usa os contratos ativos, as contas a pagar e as previstas (recorrentes e parcelas), a comissão de parceiros e as premissas abaixo. <strong>Não lança nem paga nada</strong>; a distribuição de lucros é decisão dos sócios com o contador.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && <Callout tone="positive" role="status">Salvo.</Callout>}
      {v.warnings.length > 0 && <Callout tone="warning" role="status"><ul className="list-disc pl-5">{v.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Callout>}

      <section aria-label="Resumo" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Retirada sugerida por mês</p><p className="text-xl font-semibold">{brl(plan.suggestedMonthlyCents)}</p><p className="text-xs text-muted-foreground">média dos 3 primeiros meses, com a retenção{hasCash ? " e a reposição da reserva" : ""}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Retirada planejada por mês</p><p className={`text-xl font-semibold ${v.plannedTotalCents > plan.suggestedMonthlyCents ? "text-warning-foreground" : ""}`}>{brl(v.plannedTotalCents)}</p><p className="text-xs text-muted-foreground">soma dos sócios ativos</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Resultado médio (3 meses)</p><p className={`text-xl font-semibold ${neg(plan.avgOperatingCents)}`}>{brl(plan.avgOperatingCents)}</p><p className="text-xs text-muted-foreground">entradas − despesas − comissões</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Reserva de caixa alvo</p><p className="text-xl font-semibold">{brl(plan.reserveTargetCents)}</p><p className="text-xs text-muted-foreground">{settings.reserveMonths} mês(es) de despesa{plan.reserveGapCents !== null ? ` · falta ${brl(plan.reserveGapCents)}` : ""}</p></div>
      </section>

      <SectionCard title="Mês a mês (cenário base e pessimista)">
        <div className="overflow-x-auto"><table className="w-full min-w-[46rem] text-sm">
          <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">Mês</th><th className="pr-3 text-right">Entradas</th><th className="pr-3 text-right">Despesas</th><th className="pr-3 text-right">Comissões</th><th className="pr-3 text-right">Resultado</th><th className="pr-3 text-right">Retiradas</th><th className="pr-3 text-right">Após retiradas</th>{hasCash && <th className="pr-3 text-right">Caixa</th>}<th className="text-right">Pessimista{hasCash ? " (caixa)" : ""}</th></tr></thead>
          <tbody className="divide-y divide-border">{plan.months.map((m) => (
            <tr key={m.month}><td className="py-1.5 pr-3 whitespace-nowrap">{mes(m.month)}</td><td className="pr-3 text-right">{brl(m.base.receiptsCents)}</td><td className="pr-3 text-right">{brl(m.base.expensesCents - m.base.commissionCents)}</td><td className="pr-3 text-right">{brl(m.base.commissionCents)}</td>
              <td className={`pr-3 text-right ${neg(m.base.operatingCents)}`}>{brl(m.base.operatingCents)}</td><td className="pr-3 text-right">{brl(m.plannedWithdrawalCents)}</td><td className={`pr-3 text-right ${neg(m.base.afterWithdrawalsCents)}`}>{brl(m.base.afterWithdrawalsCents)}</td>
              {hasCash && <td className={`pr-3 text-right ${neg(m.base.cashEndCents)}`}>{brl(m.base.cashEndCents ?? 0)}</td>}
              <td className={`text-right ${neg(hasCash ? m.pessimistic.cashEndCents : m.pessimistic.afterWithdrawalsCents)}`}>{brl(hasCash ? m.pessimistic.cashEndCents ?? 0 : m.pessimistic.afterWithdrawalsCents)}</td></tr>
          ))}</tbody></table></div>
        <p className="mt-3 text-xs text-muted-foreground">A entrada de um mês vem dos contratos ativos no mês anterior (a cobrança vence no mês seguinte), menos a inadimplência esperada. Cenário pessimista: +10 pontos de inadimplência e de imprevistos. Contratos ativos hoje: {v.contracts.activeCount} ({brl(v.contracts.activeMonthlyCents)}/mês).</p>
      </SectionCard>

      <SectionCard title="Sócios: planejado, realizado e saldo">
        {v.partners.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum sócio cadastrado (Configurações → Despesas).</p> : (
          <ul className="divide-y divide-border">
            {v.partners.map((p) => (
              <li key={p.partnerId} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0"><p className="font-medium">{p.name}{!p.active && <span className="ml-2 text-xs text-muted-foreground">(inativo: fora do plano)</span>}</p>
                  <p className="text-xs text-muted-foreground">retirou no ano {brl(p.withdrawnYearCents)} · no mês {brl(p.withdrawnMonthCents)} · saldo {p.balanceCents < 0 ? `deve ${brl(-p.balanceCents)} à empresa` : p.balanceCents > 0 ? `empresa deve ${brl(p.balanceCents)}` : "zerado"}</p></div>
                {manage ? (
                  <form action={savePartnerPlanAction} className="flex items-center gap-2"><input type="hidden" name="partnerId" value={p.partnerId} />
                    <label className="text-xs text-muted-foreground" htmlFor={`pl-${p.partnerId}`}>Planejado por mês (R$)</label>
                    <input id={`pl-${p.partnerId}`} name="amount" inputMode="decimal" defaultValue={(p.plannedCents / 100).toFixed(2).replace(".", ",")} className={`${inputClass} w-32`} />
                    <button className={buttonClass("outline", "sm")}>Salvar</button></form>
                ) : <span>{brl(p.plannedCents)}/mês</span>}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Previsto × realizado (meses fechados)">
        <div className="overflow-x-auto"><table className="w-full min-w-[44rem] text-sm">
          <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">Mês</th><th className="pr-3 text-right">Entrada prevista</th><th className="pr-3 text-right">Recebido</th><th className="pr-3 text-right">Conta a vencer</th><th className="pr-3 text-right">Pago</th><th className="pr-3 text-right">Retirada planejada</th><th className="text-right">Retirado</th></tr></thead>
          <tbody className="divide-y divide-border">{v.variance.months.map((m) => <tr key={m.month}><td className="py-1.5 pr-3 whitespace-nowrap">{mes(m.month)}{m.partial && <span className="ml-1 text-xs text-muted-foreground">(em andamento)</span>}</td><td className="pr-3 text-right">{brl(m.expectedReceiptsCents)}</td><td className="pr-3 text-right">{brl(m.receivedCents)}</td><td className="pr-3 text-right">{brl(m.dueExpensesCents)}</td><td className="pr-3 text-right">{brl(m.paidExpensesCents)}</td><td className="pr-3 text-right">{brl(m.plannedWithdrawalCents)}</td><td className="text-right">{brl(m.withdrawnCents)}</td></tr>)}</tbody>
          <tfoot><tr className="border-t font-medium"><td className="py-1.5 pr-3">Total ({v.variance.closedMonths} mês(es) fechado(s))</td><td className="pr-3 text-right">{brl(v.variance.totals.expectedReceiptsCents)}</td><td className="pr-3 text-right">{brl(v.variance.totals.receivedCents)}</td><td className="pr-3 text-right">{brl(v.variance.totals.dueExpensesCents)}</td><td className="pr-3 text-right">{brl(v.variance.totals.paidExpensesCents)}</td><td className="pr-3 text-right">{brl(v.variance.totals.plannedWithdrawalCents)}</td><td className="text-right">{brl(v.variance.totals.withdrawnCents)}</td></tr></tfoot></table></div>
        <p className="mt-3 text-xs text-muted-foreground">A entrada prevista usa os contratos de hoje (o sistema não guarda o histórico de mudanças) e a inadimplência das premissas; as cobranças anteriores ao sistema ainda não foram lançadas, então &quot;Recebido&quot; pode ficar abaixo do previsto. &quot;Conta a vencer&quot; são as contas com vencimento no mês; &quot;Pago&quot;, as baixas feitas no mês: pagar em outro mês aparece como diferença. A retirada planejada é o valor de hoje.</p>
      </SectionCard>

      <SectionCard title="Realizado (dinheiro que já passou pelo sistema)">
        <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm">
          <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground"><th className="py-2 pr-3">Mês</th><th className="pr-3 text-right">Recebido</th><th className="pr-3 text-right">Despesas pagas</th><th className="pr-3 text-right">Resultado</th><th className="text-right">Retiradas</th></tr></thead>
          <tbody className="divide-y divide-border">{v.realized.map((r) => <tr key={r.month}><td className="py-1.5 pr-3">{mes(r.month)}</td><td className="pr-3 text-right">{brl(r.receiptsCents)}</td><td className="pr-3 text-right">{brl(r.paidExpensesCents)}</td><td className={`pr-3 text-right ${neg(r.receiptsCents - r.paidExpensesCents)}`}>{brl(r.receiptsCents - r.paidExpensesCents)}</td><td className="text-right">{brl(r.withdrawalsCents)}</td></tr>)}</tbody></table></div>
        <p className="mt-3 text-sm">No ano até hoje: recebido {brl(v.ytd.receiptsCents)} − despesas pagas {brl(v.ytd.paidExpensesCents)} = <strong className={neg(v.ytd.resultCents)}>{brl(v.ytd.resultCents)}</strong>; retiradas {brl(v.ytd.withdrawalsCents)}.</p>
        <p className="mt-1 text-xs text-muted-foreground">Só conta o que foi registrado aqui (recebimentos e baixas de contas a pagar). O histórico anterior entra depois que a planilha for conferida e aplicada.</p>
      </SectionCard>

      {manage && (
        <SectionCard title="Premissas">
          <form action={saveSettingsAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div><label htmlFor="delinquency" className="mb-1 block text-sm font-medium">Inadimplência esperada (%)</label><input id="delinquency" name="delinquency" inputMode="decimal" required defaultValue={pct(settings.delinquencyBps)} className={inputClass} /></div>
            <div><label htmlFor="unplanned" className="mb-1 block text-sm font-medium">Imprevistos sobre as despesas (%)</label><input id="unplanned" name="unplanned" inputMode="decimal" required defaultValue={pct(settings.unplannedBps)} className={inputClass} /></div>
            <div><label htmlFor="retention" className="mb-1 block text-sm font-medium">Parte do resultado que não se retira (%)</label><input id="retention" name="retention" inputMode="decimal" required defaultValue={pct(settings.retentionBps)} className={inputClass} /></div>
            <div><label htmlFor="reserveMonths" className="mb-1 block text-sm font-medium">Reserva de caixa (meses de despesa)</label><input id="reserveMonths" name="reserveMonths" type="number" min={0} max={24} required defaultValue={settings.reserveMonths} className={inputClass} /></div>
            <div><label htmlFor="cashNow" className="mb-1 block text-sm font-medium">Caixa atual (R$, opcional)</label><input id="cashNow" name="cashNow" inputMode="decimal" defaultValue={settings.cashNowCents === null ? "" : (settings.cashNowCents / 100).toFixed(2).replace(".", ",")} className={inputClass} /></div>
            <div><label htmlFor="cashAsOf" className="mb-1 block text-sm font-medium">Caixa em (data)</label><input id="cashAsOf" name="cashAsOf" type="date" max={v.today} defaultValue={settings.cashAsOf ?? ""} className={inputClass} /></div>
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-3">{settings.isDefault ? "Valores padrão (ainda não salvos). " : ""}A <strong>retenção</strong> reduz o que o sistema sugere retirar (folga para imposto sobre o lucro, investimento e imprevistos). O <strong>caixa atual</strong> liga a projeção de caixa e a reposição da reserva.</p>
            <div className="sm:col-span-2 lg:col-span-3"><button className={buttonClass("primary")}>Salvar premissas</button></div>
          </form>
        </SectionCard>
      )}
    </div>
  );
}
