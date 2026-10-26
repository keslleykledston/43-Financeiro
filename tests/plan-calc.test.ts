import { describe, expect, it } from "vitest";
import { activeIn, buildForecast, type PlanInput } from "@/modules/expenses/plan-calc";

const S = { delinquencyBps: 0, unplannedBps: 0, reserveMonths: 2, retentionBps: 0, cashNowCents: null };
const C = (monthlyCents: number, startAt = "2026-01-01", status = "ativo", commissionBps: number | null = null) => ({ monthlyCents, startAt, status, commissionBps });
const base = (o: Partial<PlanInput> = {}): PlanInput => ({ firstMonth: "2026-11", months: 4, settings: S, contracts: [C(100000)], knownExpensesCents: {}, plannedWithdrawalCents: 0, ...o });

describe("D4 — previsão de lucro e plano de retiradas (cálculo puro)", () => {
  it("contratos: só 'ativo' e já iniciado no mês; rascunho, suspenso e encerrado não contam", () => {
    const cs = [C(100), C(200, "2026-12-01"), C(400, "2026-01-01", "rascunho"), C(800, "2026-01-01", "suspenso"), C(1600, "2026-01-01", "encerrado")];
    expect(activeIn(cs, "2026-11").map((c) => c.monthlyCents)).toEqual([100]);
    expect(activeIn(cs, "2026-12").map((c) => c.monthlyCents)).toEqual([100, 200]);
    expect(activeIn(cs, "2026-12-15".slice(0, 7)).length).toBe(2);
  });
  it("entrada do mês X vem da competência X−1, com inadimplência; despesa = conhecida + imprevistos", () => {
    const r = buildForecast(base({ settings: { ...S, delinquencyBps: 1000, unplannedBps: 500 }, contracts: [C(100000), C(50000, "2026-11-10")], knownExpensesCents: { "2026-11": 60000, "2026-12": 60000 } }));
    // nov: competência out = só o 1º contrato (100.000) − 10% = 90.000; dez: competência nov = 150.000 − 10% = 135.000
    expect(r.months[0].base).toMatchObject({ receiptsCents: 90000, expensesCents: 63000, operatingCents: 27000 });
    expect(r.months[1].base).toMatchObject({ receiptsCents: 135000, expensesCents: 63000, operatingCents: 72000 });
    expect(r.months[0].contractsActive).toBe(1); expect(r.months[1].contractsActive).toBe(2);
  });
  it("comissão: paga em X sobre o recebido em X−1 (contratos de X−2)", () => {
    const r = buildForecast(base({ settings: { ...S, delinquencyBps: 1000 }, contracts: [C(100000, "2026-01-01", "ativo", 3000), C(100000, "2026-11-01")] }));
    // comissão bruta mensal do 1º contrato = 30.000; recebido 90% → 27.000, a partir do mês cuja X−2 já tem o contrato (todos, pois começou em jan)
    expect(r.months.map((m) => m.base.commissionCents)).toEqual([27000, 27000, 27000, 27000]);
    expect(r.months[0].base.expensesCents).toBe(27000);
  });
  it("retiradas planejadas entram no resultado e o caixa acumula; cenário pessimista é pior", () => {
    const r = buildForecast(base({ settings: { ...S, delinquencyBps: 300, unplannedBps: 500, cashNowCents: 50000 }, knownExpensesCents: { "2026-11": 50000, "2026-12": 50000, "2027-01": 50000, "2027-02": 50000 }, plannedWithdrawalCents: 30000 }));
    const m = r.months;
    expect(m[0].base).toMatchObject({ receiptsCents: 97000, expensesCents: 52500, operatingCents: 44500, afterWithdrawalsCents: 14500, cashEndCents: 64500 });
    expect(m[3].base.cashEndCents).toBe(50000 + 4 * 14500);
    expect(m[0].pessimistic.receiptsCents).toBe(87000); // 3% + 10pp = 13%
    expect(m[0].pessimistic.expensesCents).toBe(50000 + 7500); // 5% + 10pp = 15%
    expect(m[0].pessimistic.operatingCents).toBeLessThan(m[0].base.operatingCents);
    expect(r.firstNegativeCash).toEqual({ base: null, pessimistic: null });
  });
  it("aponta o primeiro mês com caixa negativo", () => {
    const r = buildForecast(base({ settings: { ...S, cashNowCents: 10000 }, knownExpensesCents: { "2026-11": 100000, "2026-12": 150000, "2027-01": 150000 }, plannedWithdrawalCents: 0 }));
    // out=100000 de entrada; nov: +100000−100000 = 0 → caixa 10000; dez: −50000 → −40000
    expect(r.months[0].base.cashEndCents).toBe(10000);
    expect(r.firstNegativeCash.base).toBe("2026-12");
  });
  it("sugestão de retirada: média dos 3 primeiros meses, menos retenção, menos reposição da reserva; nunca negativa", () => {
    const sem = buildForecast(base({ settings: { ...S, retentionBps: 2000 }, knownExpensesCents: { "2026-11": 40000, "2026-12": 40000, "2027-01": 40000, "2027-02": 40000 } }));
    expect(sem.avgOperatingCents).toBe(60000);
    expect(sem.suggestedMonthlyCents).toBe(48000); // 60.000 × 80%
    expect(sem.reserveTargetCents).toBe(2 * 40000);
    expect(sem.reserveGapCents).toBeNull();
    const com = buildForecast(base({ settings: { ...S, retentionBps: 2000, cashNowCents: 20000 }, knownExpensesCents: { "2026-11": 40000, "2026-12": 40000, "2027-01": 40000, "2027-02": 40000 } }));
    expect(com.reserveGapCents).toBe(60000); // alvo 80.000 − caixa 20.000
    expect(com.suggestedMonthlyCents).toBe(48000 - 5000); // 60.000 / 12 por mês
    const ruim = buildForecast(base({ knownExpensesCents: { "2026-11": 500000, "2026-12": 500000, "2027-01": 500000 } }));
    expect(ruim.suggestedMonthlyCents).toBe(0);
  });
  it("sem contratos ativos: receita zero e sugestão zero", () => {
    const r = buildForecast(base({ contracts: [C(1000, "2026-01-01", "rascunho")], knownExpensesCents: { "2026-11": 1000 } }));
    expect(r.months[0].base.receiptsCents).toBe(0);
    expect(r.suggestedMonthlyCents).toBe(0);
  });
  it("pessimista: imprevistos e inadimplência nunca passam de 100%", () => {
    const r = buildForecast(base({ settings: { ...S, delinquencyBps: 10000, unplannedBps: 10000 }, knownExpensesCents: { "2026-11": 1000 } }));
    expect(r.months[0].pessimistic.expensesCents).toBe(2000); // 1.000 + 100% (teto), não 110%
    expect(r.months[0].pessimistic.receiptsCents).toBe(0);
  });
  it("valor acima do inteiro seguro falha de forma explícita", () => {
    expect(() => buildForecast(base({ knownExpensesCents: { "2026-11": Number.MAX_SAFE_INTEGER } }))).toThrow(RangeError);
  });
});
