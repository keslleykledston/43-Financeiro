import { describe, expect, it } from "vitest";
import { adjustmentReference, contractAlerts, daysBetween, plusYear, type AlertInput } from "@/modules/contracts/alerts";

const base = (o: Partial<AlertInput> = {}): AlertInput => ({ id: "c1", customerName: "ALFA", status: "ativo", startAt: "2026-01-01", endAt: null, amountCents: 100000, approved: [{ cents: 100000, on: "2026-01-02" }], ...o });
const TODAY = "2026-10-24";

describe("alertas de contrato (puro)", () => {
  it("datas: dias entre e +1 ano (29/02 vira 28/02)", () => {
    expect(daysBetween("2026-10-24", "2026-11-23")).toBe(30);
    expect(daysBetween("2026-10-24", "2026-10-20")).toBe(-4);
    expect(plusYear("2026-01-01")).toBe("2027-01-01");
    expect(plusYear("2024-02-29")).toBe("2025-02-28");
    expect(plusYear("2027-12-31")).toBe("2028-12-31");
  });

  it("referência do reajuste: início, ou última aprovação que mudou o valor", () => {
    expect(adjustmentReference(base())).toBe("2026-01-01");
    expect(adjustmentReference(base({ approved: [{ cents: 1, on: "2026-01-02" }, { cents: 1, on: "2026-05-01" }] }))).toBe("2026-01-01"); // mesma quantia: não é reajuste
    expect(adjustmentReference(base({ approved: [{ cents: 1, on: "2026-01-02" }, { cents: 2, on: "2026-06-10" }, { cents: 2, on: "2026-08-01" }] }))).toBe("2026-06-10");
  });

  it("vigência: terminou, termina em breve, fora da janela, sem fim", () => {
    const a = contractAlerts([base({ id: "x", endAt: "2026-10-20" }), base({ id: "y", endAt: "2026-11-10" }), base({ id: "z", endAt: "2027-06-30" }), base({ id: "w" })], TODAY);
    expect(a.map((x) => [x.contractId, x.kind, x.days])).toEqual([["x", "vigencia_encerrada", 4], ["y", "vigencia_proxima", 17]]);
    expect(contractAlerts([base({ endAt: "2026-10-24" })], TODAY).map((x) => [x.kind, x.days])).toEqual([["vigencia_proxima", 0]]); // termina hoje ainda vale hoje
    expect(contractAlerts([base({ endAt: "2026-12-20" })], TODAY, 90).map((x) => x.kind)).toEqual(["vigencia_proxima"]);
  });

  it("reajuste: atrasado, próximo, longe e contrato que acaba antes", () => {
    const old = base({ id: "old", startAt: "2025-09-01", approved: [{ cents: 100000, on: "2025-09-02" }] }); // 12 meses em 2026-09-01
    const soon = base({ id: "soon", startAt: "2025-11-20", approved: [{ cents: 100000, on: "2025-11-21" }] }); // 2026-11-20 → 27 dias
    const far = base({ id: "far", startAt: "2026-06-01" });
    const ends = base({ id: "ends", startAt: "2025-11-20", endAt: "2026-11-01", approved: [{ cents: 100000, on: "2025-11-21" }] });
    const a = contractAlerts([old, soon, far, ends], TODAY);
    expect(a.map((x) => [x.contractId, x.kind, x.days])).toEqual([["old", "reajuste_atrasado", 53], ["ends", "vigencia_proxima", 8], ["soon", "reajuste_proximo", 27]]);
    expect(a.find((x) => x.contractId === "old")!.since).toBe("2025-09-01");
  });

  it("limites: aniversário hoje é atraso (0 dia); último dia da janela entra, o seguinte não", () => {
    expect(contractAlerts([base({ startAt: "2025-10-24", approved: [] })], TODAY).map((x) => [x.kind, x.days])).toEqual([["reajuste_atrasado", 0]]);
    expect(contractAlerts([base({ startAt: "2025-12-23", approved: [] })], TODAY, 60).map((x) => x.kind)).toEqual(["reajuste_proximo"]); // 60 dias exatos
    expect(contractAlerts([base({ startAt: "2025-12-24", approved: [] })], TODAY, 60)).toEqual([]);                                       // 61 dias
    expect(contractAlerts([base({ endAt: "2026-12-23" })], TODAY, 60).map((x) => x.kind)).toEqual(["vigencia_proxima"]);
  });

  it("reajuste aprovado zera a contagem", () => {
    const c = base({ startAt: "2025-01-01", approved: [{ cents: 100000, on: "2025-01-02" }, { cents: 108000, on: "2026-10-01" }] });
    expect(contractAlerts([c], TODAY)).toEqual([]);
  });

  it("rascunho e encerrado não alertam; suspenso só avisa vigência", () => {
    const old = { startAt: "2024-01-01", endAt: "2026-10-01" };
    expect(contractAlerts([base({ ...old, status: "rascunho" }), base({ ...old, status: "encerrado" })], TODAY)).toEqual([]);
    expect(contractAlerts([base({ ...old, status: "suspenso" })], TODAY).map((x) => x.kind)).toEqual(["vigencia_encerrada"]);
  });

  it("ordem: encerrada, reajuste atrasado, depois os mais próximos primeiro", () => {
    const a = contractAlerts([
      base({ id: "p2", endAt: "2026-11-20" }), base({ id: "p1", endAt: "2026-10-30" }),
      base({ id: "r", startAt: "2025-01-01", approved: [{ cents: 1, on: "2025-01-02" }] }), base({ id: "e", endAt: "2026-09-01" }),
    ], TODAY);
    expect(a.map((x) => x.contractId + ":" + x.kind)).toEqual(["e:vigencia_encerrada", "r:reajuste_atrasado", "p1:vigencia_proxima", "p2:vigencia_proxima"]);
  });
});
