import { describe, expect, it } from "vitest";
import { payableSituation } from "@/modules/payables/status";

const s = (status: string, amountCents: number, paidCents: number, dueDate: string, today: string) => payableSituation({ status, amountCents, paidCents, dueDate, today });
describe("E11 situação da conta a pagar (regras puras)", () => {
  it("estados de aprovação", () => {
    expect(s("rascunho", 100, 0, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "rascunho", openCents: 0, overdueDays: 0 });
    expect(s("aguardando_aprovacao", 100, 0, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "aguardando", openCents: 100, overdueDays: 19 });
    expect(s("rejeitado", 100, 0, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "rejeitada", openCents: 0, overdueDays: 0 });
    expect(s("cancelado", 100, 0, "2026-10-01", "2026-10-20")).toMatchObject({ situation: "cancelada", openCents: 0 });
  });
  it("aprovada: a vencer, vence hoje, vencida, parcial, paga (derivado das baixas)", () => {
    expect(s("aprovado", 1000, 0, "2026-10-21", "2026-10-20")).toMatchObject({ situation: "a_vencer", payable: true });
    expect(s("aprovado", 1000, 0, "2026-10-20", "2026-10-20")).toMatchObject({ situation: "a_vencer", overdueDays: 0 });
    expect(s("aprovado", 1000, 0, "2026-10-19", "2026-10-20")).toMatchObject({ situation: "vencida", overdueDays: 1 });
    expect(s("aprovado", 1000, 1, "2026-10-19", "2026-10-20")).toMatchObject({ situation: "parcial", openCents: 999, overdueDays: 1 });
    expect(s("aprovado", 1000, 1000, "2026-10-19", "2026-10-20")).toMatchObject({ situation: "paga", openCents: 0, overdueDays: 0, payable: false });
    expect(s("aprovado", 1000, 1500, "2026-10-19", "2026-10-20")).toMatchObject({ situation: "paga", openCents: 0 }); // nunca negativo
  });
});
