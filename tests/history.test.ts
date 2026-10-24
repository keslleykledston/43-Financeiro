import { describe, expect, it } from "vitest";
import { analyze, type StageRow } from "@/modules/history/analysis";

const row = (o: Partial<StageRow> = {}): StageRow => ({ sheet: "Boletos JAN 2026", row: 5, month: "2026-01", name: "ALFA REDES LTDA", documentRaw: "11.222.333/0001-81", document: "11222333000181", amountCents: 100000, netCents: 100000, dueOn: "2026-01-10", paidOn: "2026-01-11", ...o });
const KNOWN = new Set(["11222333000181"]);
const TODAY = "2026-10-24";
const kinds = (rows: StageRow[]) => analyze(rows, KNOWN, TODAY).divergences.map((d) => d.kind);

describe("H1 — análise do histórico da planilha (pura)", () => {
  it("linha limpa não gera divergência; por aba e por mês de pagamento", () => {
    const r = analyze([row(), row({ row: 6, name: "BETA", document: "12ABC34501DE35", documentRaw: "12.ABC.345/01DE-35", dueOn: "2026-01-20", paidOn: "2026-02-02", netCents: 100500 })], new Set(["11222333000181", "12ABC34501DE35"]), TODAY);
    expect(r.divergences.map((d) => d.kind)).toEqual(["liquido_diferente"]);
    expect(r.months).toEqual([{ month: "2026-01", rows: 2, billedCents: 200000, paidRows: 2, receivedCents: 200500, assumedRows: 0, assumedCents: 0, openRows: 0, openCents: 0 }]);
    expect(r.receivedByPayMonth).toEqual([{ month: "2026-01", rows: 1, cents: 100000, assumedRows: 0, assumedCents: 0 }, { month: "2026-02", rows: 1, cents: 100500, assumedRows: 0, assumedCents: 0 }]);
    expect(r.toReview).toBe(0); expect(r.customers).toBe(2);
  });

  it("vencimento: fora do mês da aba, ausente", () => {
    expect(kinds([row({ dueOn: "2026-05-10", paidOn: null })])).toEqual(["vencimento_fora_da_aba"]);
    expect(kinds([row({ dueOn: null, paidOn: null })])).toEqual(["vencimento_ausente"]);
  });

  it("pagamento: muito tardio (>120 dias), no futuro, sem líquido", () => {
    expect(kinds([row({ paidOn: "2026-05-11" })])).toEqual(["pagamento_muito_tardio"]);
    expect(kinds([row({ paidOn: "2026-05-10" })])).toEqual([]); // exatamente 120 dias: ok
    expect(kinds([row({ paidOn: "2026-12-01" })])).toContain("pagamento_futuro");
    const r = analyze([row({ netCents: null })], KNOWN, TODAY);
    expect(r.divergences.map((d) => d.kind)).toEqual(["pago_sem_liquido"]);
    expect(r.months[0]).toMatchObject({ receivedCents: 0, assumedRows: 1, assumedCents: 100000, paidRows: 1 }); // sem líquido: NÃO entra no recebido, só como estimativa (Codex H1 P1)
    expect(r.receivedByPayMonth).toEqual([{ month: "2026-01", rows: 0, cents: 0, assumedRows: 1, assumedCents: 100000 }]);
    expect(r.totals).toMatchObject({ receivedCents: 0, assumedCents: 100000, assumedRows: 1 });
  });

  it("documento: ausente, inválido, fora do cadastro", () => {
    expect(kinds([row({ documentRaw: "", document: null })])).toEqual(["sem_documento"]);
    expect(kinds([row({ documentRaw: "11.111.111/1111-11", document: null })])).toEqual(["documento_invalido"]);
    expect(kinds([row({ document: "99999999000191", documentRaw: "99.999.999/0001-91" })])).toEqual(["fora_do_cadastro"]);
  });

  it("duplicado na mesma aba (por documento; sem documento, por nome); em outra aba não conta", () => {
    expect(kinds([row(), row({ row: 9 })])).toEqual(["duplicado_no_mes", "duplicado_no_mes"]);
    expect(kinds([row({ documentRaw: "", document: null, name: "Sem Doc" }), row({ row: 9, documentRaw: "", document: null, name: "SEM DOC" })])).toEqual(["sem_documento", "sem_documento", "duplicado_no_mes", "duplicado_no_mes"]);
    expect(kinds([row(), row({ row: 9, month: "2026-02", dueOn: "2026-02-10", paidOn: "2026-02-11" })])).toEqual([]);
  });

  it("em aberto: vencido e sem pagamento; a vencer não conta", () => {
    const r = analyze([row({ paidOn: null, netCents: null }), row({ row: 7, name: "X", document: "12ABC34501DE35", dueOn: "2026-01-25", paidOn: null, netCents: null }), row({ row: 8, month: "2027-01", dueOn: "2027-01-10", paidOn: null, netCents: null })], new Set([...KNOWN, "12ABC34501DE35"]), TODAY);
    const jan = r.months.find((m) => m.month === "2026-01")!;
    expect(jan).toMatchObject({ openRows: 2, openCents: 200000, paidRows: 0, receivedCents: 0 });
    expect(r.months.find((m) => m.month === "2027-01")).toMatchObject({ openRows: 0 });
    expect(r.totals).toMatchObject({ openRows: 2, openCents: 200000 });
  });

  it("ordena as divergências e conta por tipo", () => {
    const r = analyze([row({ row: 9, documentRaw: "", document: null }), row({ row: 4, dueOn: "2026-05-10", paidOn: null })], KNOWN, TODAY);
    expect(r.divergences.map((d) => [d.kind, d.row])).toEqual([["vencimento_fora_da_aba", 4], ["sem_documento", 9]]);
    expect(r.counts).toMatchObject({ vencimento_fora_da_aba: 1, sem_documento: 1, documento_invalido: 0 }); expect(r.toReview).toBe(2);
  });
});
