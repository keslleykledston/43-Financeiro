import { describe, expect, it } from "vitest";
import { agingBucket, daysBetween, situationOf } from "@/modules/receivables/status";

const s = (amountCents: number, paidCents: number, dueDate: string, today: string) => situationOf({ amountCents, paidCents, dueDate, today });

describe("E07 situação da cobrança (regras puras)", () => {
  it("quitada só com saldo zero; parcial; vencida; a vencer", () => {
    expect(s(1000, 1000, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "quitada", openCents: 0, overdue: false, overdueDays: 0 });
    expect(s(1000, 999, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "parcial", openCents: 1, overdue: true, overdueDays: 19 });
    expect(s(1000, 0, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "vencida", openCents: 1000, overdueDays: 19 });
    expect(s(1000, 0, "2026-10-20", "2026-10-20")).toMatchObject({ situation: "a_vencer", overdue: false, overdueDays: 0 }); // vence hoje
    expect(s(1000, 0, "2026-10-21", "2026-10-20")).toMatchObject({ situation: "a_vencer" });
  });
  it("pago a mais nunca dá saldo negativo", () => { expect(s(1000, 1500, "2026-10-01", "2026-10-20")).toMatchObject({ openCents: 0, situation: "quitada" }); });
  it("dias entre datas atravessa mês, ano e bissexto", () => {
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2026-10-20", "2026-10-20")).toBe(0);
  });
  it("faixas de envelhecimento", () => {
    expect([0, 1, 15, 16, 30, 31, 60, 61, 400].map(agingBucket)).toEqual([null, "1-15", "1-15", "16-30", "16-30", "31-60", "31-60", "61+", "61+"]);
  });
});
