import { addMonths } from "@/modules/payables/schedule";

/**
 * D4 — cálculo PURO do plano de retiradas e da previsão de lucro (sem banco, sem relógio). Tudo em centavos inteiros.
 * Modelo de caixa (simples e explícito):
 *  - A competência C é cobrada com vencimento em C+1: a ENTRADA do mês X vem dos contratos ativos em X−1, menos a inadimplência esperada.
 *  - A comissão de parceiro (E18) é paga em X sobre o que entrou em X−1, ou seja, vem dos contratos ativos em X−2.
 *  - A despesa do mês X é o que já está lançado/previsto para vencer em X (contas, recorrentes, parcelas) + uma reserva para imprevistos + a comissão.
 *  - Contrato "ativo" conta desde o mês do início e SEM olhar a data de término: a renovação automática de 12 meses é regra do negócio, então contrato
 *    vencido que segue "ativo" é tratado como renovado (o plano.ts avisa quantos são). "suspenso", "encerrado" e "rascunho" não contam.
 * É uma PROJEÇÃO para decidir, não uma garantia nem o resultado contábil.
 */
export type PlanSettings = { delinquencyBps: number; unplannedBps: number; reserveMonths: number; retentionBps: number; cashNowCents: number | null };
export type ContractLite = { monthlyCents: number; startAt: string; status: string; commissionBps: number | null };
export type PlanInput = { firstMonth: string; months: number; settings: PlanSettings; contracts: ContractLite[]; knownExpensesCents: Record<string, number>; plannedWithdrawalCents: number };
export type Scenario = { receiptsCents: number; expensesCents: number; commissionCents: number; operatingCents: number; afterWithdrawalsCents: number; cashEndCents: number | null };
export type PlanMonth = { month: string; contractsActive: number; knownExpensesCents: number; plannedWithdrawalCents: number; base: Scenario; pessimistic: Scenario };
export type PlanResult = { months: PlanMonth[]; reserveTargetCents: number; suggestedMonthlyCents: number; avgOperatingCents: number; avgExpensesCents: number; reserveGapCents: number | null; firstNegativeCash: { base: string | null; pessimistic: string | null } };

export const PESSIMISTIC_PP_BPS = 1000; // cenário pessimista: +10 pontos de inadimplência e +10 pontos de imprevistos
const bps = (c: number, b: number) => Math.round((c * b) / 10000);
/** Soma ou produto fora do inteiro seguro (carteira ou contas absurdas) vira erro explícito, nunca número errado. */
const safe = (n: number) => { if (!Number.isSafeInteger(n)) throw new RangeError("Valores acima do limite suportado pelo plano"); return n; };
const lastDay = (month: string) => `${month}-31`; // comparação de texto AAAA-MM-DD: "-31" é maior que qualquer dia do mês

/** Contratos ativos na competência `month`: status ativo e já iniciados no fim desse mês. */
export function activeIn(contracts: ContractLite[], month: string) {
  return contracts.filter((c) => c.status === "ativo" && c.startAt <= lastDay(month));
}
const grossOf = (cs: ContractLite[], month: string) => activeIn(cs, month).reduce((a, c) => a + c.monthlyCents, 0);
const commissionGrossOf = (cs: ContractLite[], month: string) => activeIn(cs, month).reduce((a, c) => a + (c.commissionBps ? bps(c.monthlyCents, c.commissionBps) : 0), 0);

export function buildForecast(i: PlanInput): PlanResult {
  const s = i.settings;
  const scen = (extraBps: number) => {
    const d = Math.min(10000, s.delinquencyBps + extraBps), u = Math.min(10000, s.unplannedBps + extraBps); // tetos: nunca passa de 100%
    let cash = s.cashNowCents;
    return Array.from({ length: i.months }, (_, k): [string, Scenario] => {
      const month = addMonths(i.firstMonth, k);
      const receipts = safe(bps(safe(grossOf(i.contracts, addMonths(month, -1))), 10000 - d));
      const commission = safe(bps(safe(commissionGrossOf(i.contracts, addMonths(month, -2))), 10000 - d));
      const known = i.knownExpensesCents[month] ?? 0;
      const expenses = safe(known + bps(safe(known), u) + commission);
      const operating = receipts - expenses;
      const after = operating - i.plannedWithdrawalCents;
      if (cash !== null) cash += after;
      return [month, { receiptsCents: receipts, expensesCents: expenses, commissionCents: commission, operatingCents: operating, afterWithdrawalsCents: after, cashEndCents: cash }];
    });
  };
  const base = scen(0), pess = scen(PESSIMISTIC_PP_BPS);
  const months: PlanMonth[] = base.map(([month, b], k) => ({ month, contractsActive: activeIn(i.contracts, addMonths(month, -1)).length, knownExpensesCents: i.knownExpensesCents[month] ?? 0, plannedWithdrawalCents: i.plannedWithdrawalCents, base: b, pessimistic: pess[k][1] }));
  const n = months.length || 1;
  const avgExpenses = Math.round(months.reduce((a, m) => a + m.base.expensesCents, 0) / n);
  const reserveTarget = s.reserveMonths * avgExpenses;
  const head = months.slice(0, Math.min(3, months.length));
  const avgOperating = head.length ? Math.round(head.reduce((a, m) => a + m.base.operatingCents, 0) / head.length) : 0;
  const reserveGap = s.cashNowCents === null ? null : Math.max(0, reserveTarget - s.cashNowCents);
  const fill = reserveGap === null ? 0 : Math.round(reserveGap / 12);
  const suggested = Math.max(0, bps(Math.max(0, avgOperating), 10000 - s.retentionBps) - fill);
  const neg = (key: "base" | "pessimistic") => months.find((m) => m[key].cashEndCents !== null && m[key].cashEndCents! < 0)?.month ?? null;
  return { months, reserveTargetCents: reserveTarget, suggestedMonthlyCents: suggested, avgOperatingCents: avgOperating, avgExpensesCents: avgExpenses, reserveGapCents: reserveGap, firstNegativeCash: { base: neg("base"), pessimistic: neg("pessimistic") } };
}

/**
 * D4b — previsto × realizado (PURO). Usa as MESMAS regras da projeção, aplicadas aos meses passados com os contratos de hoje (não há histórico de mudança de status):
 *  - Entrada prevista do mês X = contratos ativos em X−1 menos a inadimplência esperada; realizada = o que foi recebido (baixas) em X.
 *  - Despesa prevista = contas com vencimento em X (não canceladas); realizada = baixas de contas feitas em X. Diferença de calendário (pagou em outro mês) aparece como diferença, não como erro.
 *  - Retirada planejada (soma dos sócios ativos, valor de hoje) × retirada lançada em X.
 * O mês corrente é PARCIAL (ainda não terminou) e fica fora dos totais.
 */
export type VarianceInput = { months: string[]; currentMonth: string; delinquencyBps: number; contracts: ContractLite[]; dueByMonth: Record<string, number>; paidByMonth: Record<string, number>; receivedByMonth: Record<string, number>; withdrawnByMonth: Record<string, number>; plannedWithdrawalCents: number };
export type VarianceMonth = { month: string; partial: boolean; expectedReceiptsCents: number; receivedCents: number; receiptsGapCents: number; dueExpensesCents: number; paidExpensesCents: number; expensesGapCents: number; plannedWithdrawalCents: number; withdrawnCents: number; withdrawalGapCents: number };
export type VarianceResult = { months: VarianceMonth[]; totals: Omit<VarianceMonth, "month" | "partial">; closedMonths: number };

export function buildVariance(i: VarianceInput): VarianceResult {
  const d = Math.min(10000, i.delinquencyBps);
  const months = i.months.map((month): VarianceMonth => {
    const expected = safe(bps(safe(grossOf(i.contracts, addMonths(month, -1))), 10000 - d));
    const received = i.receivedByMonth[month] ?? 0, due = i.dueByMonth[month] ?? 0, paid = i.paidByMonth[month] ?? 0, wd = i.withdrawnByMonth[month] ?? 0;
    return { month, partial: month >= i.currentMonth, expectedReceiptsCents: expected, receivedCents: received, receiptsGapCents: received - expected, dueExpensesCents: due, paidExpensesCents: paid, expensesGapCents: paid - due, plannedWithdrawalCents: i.plannedWithdrawalCents, withdrawnCents: wd, withdrawalGapCents: wd - i.plannedWithdrawalCents };
  });
  const closed = months.filter((m) => !m.partial);
  const sum = (f: (m: VarianceMonth) => number) => safe(closed.reduce((a, m) => a + f(m), 0));
  return { months, closedMonths: closed.length, totals: { expectedReceiptsCents: sum((m) => m.expectedReceiptsCents), receivedCents: sum((m) => m.receivedCents), receiptsGapCents: sum((m) => m.receiptsGapCents), dueExpensesCents: sum((m) => m.dueExpensesCents), paidExpensesCents: sum((m) => m.paidExpensesCents), expensesGapCents: sum((m) => m.expensesGapCents), plannedWithdrawalCents: sum((m) => m.plannedWithdrawalCents), withdrawnCents: sum((m) => m.withdrawnCents), withdrawalGapCents: sum((m) => m.withdrawalGapCents) } };
}
