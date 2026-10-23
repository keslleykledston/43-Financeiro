import { describe, expect, it } from "vitest";
import { WEEKS, buildAlerts, buildForecast, horizonEnd, lastMonths, weekIndex, weekStart, type AlertInput } from "@/modules/insights/calc";

const TODAY = "2026-10-21"; // quarta-feira; semana começa em 19/10
describe("E12 cálculos do painel", () => {
  it("semana começa na segunda; horizonte de 13 semanas", () => {
    expect(weekStart("2026-10-21")).toBe("2026-10-19"); expect(weekStart("2026-10-19")).toBe("2026-10-19"); expect(weekStart("2026-10-25")).toBe("2026-10-19"); expect(weekStart("2026-10-26")).toBe("2026-10-26");
    expect(horizonEnd(TODAY)).toBe("2027-01-17"); // 19/10 + 91 dias − 1
    expect(WEEKS).toBe(13);
  });
  it("índice da semana: limites e fora do horizonte", () => {
    expect(weekIndex(TODAY, "2026-10-21")).toBe(0); expect(weekIndex(TODAY, "2026-10-25")).toBe(0); expect(weekIndex(TODAY, "2026-10-26")).toBe(1);
    expect(weekIndex(TODAY, "2027-01-17")).toBe(12); expect(weekIndex(TODAY, "2027-01-18")).toBeNull(); expect(weekIndex(TODAY, "2026-10-18")).toBeNull();
  });
  it("projeção: vencido fica à parte; confirmado × previsto por semana; além do horizonte contado separado; nada some", () => {
    const f = buildForecast(TODAY, [
      { dueDate: "2026-10-10", cents: 1000 }, // vencido: não é projetado como entrada
      { dueDate: "2026-10-21", cents: 200 }, { dueDate: "2026-10-27", cents: 300 }, { dueDate: "2027-02-01", cents: 700 },
    ], [{ dueDate: "2026-10-28", cents: 5000 }, { dueDate: "2026-09-01", cents: 111 }, { dueDate: "2030-01-01", cents: 9 }]);
    expect(f.overdueCents).toBe(1000); expect(f.beyondCents).toBe(700); expect(f.plannedOverdueCount).toBe(1);
    expect(f.weeks[0]).toMatchObject({ start: "2026-10-19", end: "2026-10-25", confirmedCents: 200, plannedCents: 0 });
    expect(f.weeks[1]).toMatchObject({ confirmedCents: 300, plannedCents: 5000 });
    expect(f.totals).toEqual({ confirmedCents: 500, plannedCents: 5000 });
    expect(f.weeks).toHaveLength(13); expect(f.end).toBe("2027-01-17");
    // conservação: tudo que entrou está em algum balde
    expect(f.totals.confirmedCents + f.overdueCents + f.beyondCents).toBe(1000 + 200 + 300 + 700);
  });
  it("últimos meses", () => { expect(lastMonths("2026-02", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]); });

  const base: AlertInput = { overdueCents: 0, overdueCount: 0, openCents: 0, over30Cents: 0, draftBatches: [], dueSoonCount: 0, pendingCredits: 0, accounts: 0, daysSinceLastTx: null, blockedMessages: 0, failedIssuance: 0, customersNoContact: 0, customersNoContract: 0, plannedOverdueCount: 0 };
  it("alertas: ordem por gravidade, limiares e links", () => {
    expect(buildAlerts(base, TODAY)).toEqual([]);
    expect(buildAlerts({ ...base, openCents: 100 }, TODAY)[0]).toMatchObject({ severity: "positive", title: "Nenhuma cobrança vencida" });
    const a = buildAlerts({ ...base, openCents: 1000, overdueCents: 50, overdueCount: 1 }, TODAY);
    expect(a[0]).toMatchObject({ key: "overdue", severity: "warning", href: "/contas-a-receber?status=vencidas" }); // 5% < 10%
    expect(buildAlerts({ ...base, openCents: 1000, overdueCents: 100, overdueCount: 2 }, TODAY)[0].severity).toBe("critical"); // 10%
    expect(buildAlerts({ ...base, openCents: 100000, overdueCents: 50, overdueCount: 1, over30Cents: 50 }, TODAY)[0].severity).toBe("critical"); // > 30 dias
    const l = buildAlerts({ ...base, draftBatches: [{ id: "a", issueDate: "2026-10-20" }, { id: "b", issueDate: "2026-10-21" }, { id: "c", issueDate: "2026-10-23" }] }, TODAY);
    expect(l.map((x) => [x.key, x.severity])).toEqual([["batch-a", "critical"], ["batch-b", "warning"], ["batch-c", "warning"]]);
    expect(l[0].detail).toContain("passou há 1 dia"); expect(l[1].detail).toContain("é hoje"); expect(l[2].detail).toContain("2 dia(s)");
    const g = buildAlerts({ ...base, accounts: 1, pendingCredits: 3, daysSinceLastTx: 9, blockedMessages: 1, failedIssuance: 2, customersNoContact: 4, customersNoContract: 63, plannedOverdueCount: 2, dueSoonCount: 1 }, TODAY).map((x) => x.key);
    expect(g).toEqual(expect.arrayContaining(["missing-charges", "stale-statement", "failed-issuance", "due-soon", "reconcile", "blocked-msgs", "no-contract", "no-contact"]));
    expect(g.indexOf("stale-statement")).toBeLessThan(g.indexOf("reconcile")); // atenção antes de informação
    // sem conta bancária cadastrada: nada de alerta de extrato
    expect(buildAlerts({ ...base, accounts: 0, pendingCredits: 5, daysSinceLastTx: null }, TODAY)).toEqual([]);
    expect(buildAlerts({ ...base, accounts: 1, daysSinceLastTx: null }, TODAY)[0]).toMatchObject({ key: "stale-statement", detail: "Nenhuma transação importada ainda." });
  });
});
