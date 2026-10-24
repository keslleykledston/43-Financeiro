import { describe, expect, it } from "vitest";
import { adjustmentReference, contractAlerts, daysBetween, nextRenewal, plusYear, plusYears, type AlertInput } from "@/modules/contracts/alerts";

const base = (o: Partial<AlertInput> = {}): AlertInput => ({ id: "c1", customerName: "ALFA", status: "ativo", startAt: "2026-01-01", endAt: null, amountCents: 100000, approved: [{ cents: 100000, on: "2026-01-02" }], ...o });
const TODAY = "2026-10-24";
const kinds = (a: ReturnType<typeof contractAlerts>) => a.map((x) => x.kind);

describe("alertas de contrato (puro) — contrato vale 12 meses e renova sozinho", () => {
  it("datas: dias entre, +1 ano (29/02 vira 28/02) e +N anos a partir da data original", () => {
    expect(daysBetween("2026-10-24", "2026-11-23")).toBe(30);
    expect(daysBetween("2026-10-24", "2026-10-20")).toBe(-4);
    expect(plusYear("2026-01-01")).toBe("2027-01-01");
    expect(plusYear("2024-02-29")).toBe("2025-02-28");
    expect(plusYear("2027-12-31")).toBe("2028-12-31");
    expect(plusYears("2024-02-29", 4)).toBe("2028-02-29");
    expect(plusYears("2024-02-29", 1)).toBe("2025-02-28");
  });

  it("próxima renovação: primeiro aniversário do início que cai hoje ou depois", () => {
    expect(nextRenewal("2026-01-01", TODAY)).toBe("2027-01-01");
    expect(nextRenewal("2025-10-24", TODAY)).toBe("2026-10-24"); // faz 12 meses hoje
    expect(nextRenewal("2025-10-23", TODAY)).toBe("2027-10-23"); // ontem renovou: a próxima é a de 2027
    expect(nextRenewal("2024-03-01", TODAY)).toBe("2027-03-01"); // 3º ciclo
    expect(nextRenewal("2026-12-01", TODAY)).toBe("2027-12-01"); // ainda nem começou: primeira renovação é +12 meses
  });

  it("referência do reajuste: início, ou última aprovação que mudou o valor", () => {
    expect(adjustmentReference(base())).toBe("2026-01-01");
    expect(adjustmentReference(base({ approved: [{ cents: 1, on: "2026-01-02" }, { cents: 1, on: "2026-05-01" }] }))).toBe("2026-01-01"); // mesma quantia: não é reajuste
    expect(adjustmentReference(base({ approved: [{ cents: 1, on: "2026-01-02" }, { cents: 2, on: "2026-06-10" }, { cents: 2, on: "2026-08-01" }] }))).toBe("2026-06-10");
  });

  it("sem data final = renova sozinho: avisa a renovação (com o reajuste junto, se for o mesmo dia)", () => {
    expect(contractAlerts([base()], TODAY, 60)).toEqual([]);                                  // renova em 69 dias: fora da janela
    const a = contractAlerts([base()], TODAY, 90);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "renovacao_proxima", date: "2027-01-01", days: 69, withAdjustment: true });
    expect(contractAlerts([base({ endAt: "2027-06-30" })], TODAY, 90).map((x) => x.kind)).toEqual(["renovacao_proxima"]); // fim depois da renovação: ainda renova antes
  });

  it("data final informada: terminou, termina em breve, fora da janela — e então NÃO renova", () => {
    const a = contractAlerts([base({ id: "x", endAt: "2026-10-20" }), base({ id: "y", endAt: "2026-11-10" }), base({ id: "z", endAt: "2027-06-30" }), base({ id: "w" })], TODAY);
    expect(a.map((x) => [x.contractId, x.kind, x.days])).toEqual([["x", "vigencia_encerrada", 4], ["y", "vigencia_proxima", 17]]);
    expect(contractAlerts([base({ endAt: "2026-10-24" })], TODAY).map((x) => [x.kind, x.days])).toEqual([["vigencia_proxima", 0]]); // termina hoje ainda vale hoje
    expect(kinds(contractAlerts([base({ endAt: "2026-12-20" })], TODAY, 90))).toEqual(["vigencia_proxima"]);              // acaba antes de renovar: sem renovação nem reajuste
  });

  it("reajuste: atrasado; próximo (valor mudou no meio do ciclo); junto da renovação; contrato que acaba antes", () => {
    const old = base({ id: "old", startAt: "2025-09-01", approved: [{ cents: 100000, on: "2025-09-02" }] }); // 12 meses em 2026-09-01
    const soon = base({ id: "soon", startAt: "2025-11-20", approved: [{ cents: 100000, on: "2025-11-21" }] }); // renova e reajusta em 2026-11-20 (27 dias)
    const mid = base({ id: "mid", startAt: "2025-01-15", approved: [{ cents: 1, on: "2025-01-16" }, { cents: 2, on: "2025-11-20" }] }); // reajustou em 2025-11-20: próximo em 2026-11-20; renova só em 2027-01-15
    const far = base({ id: "far", startAt: "2026-06-01" });
    const ends = base({ id: "ends", startAt: "2025-11-20", endAt: "2026-11-01", approved: [{ cents: 100000, on: "2025-11-21" }] });
    const a = contractAlerts([old, soon, mid, far, ends], TODAY);
    expect(a.map((x) => [x.contractId, x.kind, x.days])).toEqual([["old", "reajuste_atrasado", 53], ["ends", "vigencia_proxima", 8], ["soon", "renovacao_proxima", 27], ["mid", "reajuste_proximo", 27]]);
    expect(a.find((x) => x.contractId === "old")!.since).toBe("2025-09-01");
    expect(a.find((x) => x.contractId === "soon")!.withAdjustment).toBe(true);
  });

  it("limites: aniversário hoje (0 dia); último dia da janela entra, o seguinte não", () => {
    expect(contractAlerts([base({ startAt: "2025-10-24", approved: [] })], TODAY).map((x) => [x.kind, x.days])).toEqual([["renovacao_proxima", 0]]); // renova e reajusta hoje: um aviso só
    expect(contractAlerts([base({ startAt: "2025-10-24", approved: [] })], TODAY)[0].withAdjustment).toBe(true);
    expect(kinds(contractAlerts([base({ startAt: "2025-10-24", endAt: "2026-10-24", approved: [] })], TODAY))).toEqual(["vigencia_proxima"]); // fim exatamente no aniversário: nada a renovar nem reajustar
    expect(kinds(contractAlerts([base({ startAt: "2025-12-23", approved: [] })], TODAY, 60))).toEqual(["renovacao_proxima"]); // 60 dias exatos
    expect(contractAlerts([base({ startAt: "2025-12-24", approved: [] })], TODAY, 60)).toEqual([]);                          // 61 dias
    expect(kinds(contractAlerts([base({ endAt: "2026-12-23" })], TODAY, 60))).toEqual(["vigencia_proxima"]);
  });

  it("reajuste aprovado zera a contagem", () => {
    const c = base({ startAt: "2025-01-01", approved: [{ cents: 100000, on: "2025-01-02" }, { cents: 108000, on: "2026-10-01" }] });
    expect(contractAlerts([c], TODAY)).toEqual([]);
  });

  it("rascunho e encerrado não alertam; suspenso avisa data final e renovação, sem reajuste", () => {
    const old = { startAt: "2024-01-01", endAt: "2026-10-01" };
    expect(contractAlerts([base({ ...old, status: "rascunho" }), base({ ...old, status: "encerrado" })], TODAY)).toEqual([]);
    expect(kinds(contractAlerts([base({ ...old, status: "suspenso" })], TODAY))).toEqual(["vigencia_encerrada"]);
    expect(kinds(contractAlerts([base({ status: "suspenso" })], TODAY, 90))).toEqual(["renovacao_proxima"]); // suspenso ainda renova, mas não é reajustado
    expect(contractAlerts([base({ status: "suspenso" })], TODAY, 90)[0].withAdjustment).toBe(false);
  });

  it("ordem: encerrada, reajuste atrasado, fim próximo, renovação; os mais próximos primeiro", () => {
    const a = contractAlerts([
      base({ id: "ren", startAt: "2025-12-01", approved: [{ cents: 1, on: "2025-12-02" }] }),
      base({ id: "p2", endAt: "2026-11-20" }), base({ id: "p1", endAt: "2026-10-30" }),
      base({ id: "r", startAt: "2025-01-01", approved: [{ cents: 1, on: "2025-01-02" }] }), base({ id: "e", endAt: "2026-09-01" }),
    ], TODAY);
    expect(a.map((x) => x.contractId + ":" + x.kind)).toEqual(["e:vigencia_encerrada", "r:reajuste_atrasado", "p1:vigencia_proxima", "p2:vigencia_proxima", "ren:renovacao_proxima"]);
  });
});
