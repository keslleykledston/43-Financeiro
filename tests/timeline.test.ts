import { describe, expect, it } from "vitest";
import { buildTimeline } from "@/modules/history/timeline";
import type { StageRow } from "@/modules/history/analysis";

let n = 0;
const R = (name: string, month: string, cents: number, due = `${month}-10`, document: string | null = name.toLowerCase().replace(/\W/g, "")): StageRow => ({ sheet: month, row: ++n, month, name, documentRaw: document ?? "", document, amountCents: cents, netCents: null, dueOn: due, paidOn: null });
const ev = (t: ReturnType<typeof buildTimeline>, name: string) => t.customers.find((c) => c.name === name)!.events.map((e) => `${e.month}:${e.kind}`);

describe("H2 — linha do tempo inferida das abas mensais (cálculo puro)", () => {
  const rows = [
    R("Antiga", "2026-01", 100000), R("Antiga", "2026-02", 100000), R("Antiga", "2026-03", 100000), // sai em 04 (falta em 04 e 05)
    R("Estavel", "2026-01", 50000), R("Estavel", "2026-02", 50000), R("Estavel", "2026-03", 50000), R("Estavel", "2026-04", 50000), R("Estavel", "2026-05", 50000),
    R("Nova", "2026-03", 30000), R("Nova", "2026-04", 30000), R("Nova", "2026-05", 30000),
    R("Reajustada", "2026-01", 20000), R("Reajustada", "2026-02", 20000, "2026-02-20"), R("Reajustada", "2026-03", 22000, "2026-03-20"), R("Reajustada", "2026-04", 22000, "2026-04-20"), R("Reajustada", "2026-05", 22000, "2026-05-20"),
    R("Intermitente", "2026-01", 10000), R("Intermitente", "2026-03", 12000), R("Intermitente", "2026-04", 12000), R("Intermitente", "2026-05", 12000),
    R("SoNoUltimo", "2026-04", 5000), // fim em 04, ausente em 05 (último mês): "a confirmar"
  ];
  const t = buildTimeline(rows);
  it("eixo contínuo de meses e eventos por cliente", () => {
    expect(t.months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
    expect(ev(t, "Antiga")).toEqual(["2026-01:base", "2026-04:saiu"]);
    expect(ev(t, "Estavel")).toEqual(["2026-01:base"]);
    expect(ev(t, "Nova")).toEqual(["2026-03:entrou"]);
    expect(ev(t, "Reajustada")).toEqual(["2026-01:base", "2026-02:vencimento", "2026-03:valor_subiu"]);
    expect(ev(t, "Intermitente")).toEqual(["2026-01:base", "2026-02:sumiu", "2026-03:voltou", "2026-03:valor_subiu"]);
    expect(ev(t, "SoNoUltimo")).toEqual(["2026-04:entrou", "2026-05:ausente_ultimo"]); // nunca "saiu" por faltar só no último mês
  });
  it("ponte de receita fecha: início + novos + voltaram + aumentos − reduções − saídas = fim", () => {
    for (const b of t.bridge) expect(b.startCents + b.newCents + b.returningCents + b.expansionCents - b.contractionCents - b.churnCents).toBe(b.endCents);
    const m5 = t.bridge.find((b) => b.month === "2026-05")!;
    expect(m5).toMatchObject({ provisional: true, churnCents: 5000, churnCount: 1 }); // só SoNoUltimo estava em 04 e não está em 05 (provisório)
    expect(t.bridge.find((b) => b.month === "2026-04")).toMatchObject({ churnCents: 100000, churnCount: 1, provisional: false });
    const m3 = t.bridge.find((b) => b.month === "2026-03")!;
    expect(m3).toMatchObject({ newCents: 30000, newCount: 1, returningCents: 12000, returningCount: 1, expansionCents: 2000 });
    expect(t.bridge[0].month).toBe("2026-02");
  });
  it("totais", () => {
    expect(t.totals).toMatchObject({ customers: 6, entered: 2, left: 1, gone: 1, repriced: 2 });
  });
  it("várias linhas do mesmo cliente na aba somam; sem documento agrupa pelo nome; vazio não quebra", () => {
    const x = buildTimeline([R("Dois Boletos", "2026-01", 1000), R("Dois Boletos", "2026-01", 2500), R("Sem Doc", "2026-01", 700, "2026-01-05", null), R("sem  doc", "2026-02", 900, "2026-02-05", null)]);
    expect(x.customers.find((c) => c.name === "Dois Boletos")!.lastCents).toBe(3500);
    expect(x.customers.filter((c) => c.document === null)).toHaveLength(1); // "Sem Doc" e "sem  doc" são o mesmo cliente
    expect(ev(x, "Sem Doc")).toEqual(["2026-01:base", "2026-02:valor_subiu"]);
    expect(buildTimeline([])).toMatchObject({ months: [], customers: [], bridge: [] });
  });
});
