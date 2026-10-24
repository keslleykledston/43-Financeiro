import { describe, expect, it } from "vitest";
import { analyze, swapDayMonth, type StageRow } from "@/modules/history/analysis";

const row = (o: Partial<StageRow> = {}): StageRow => ({ sheet: "Boletos JAN 2026", row: 5, month: "2026-01", name: "ALFA REDES LTDA", documentRaw: "11.222.333/0001-81", document: "11222333000181", amountCents: 100000, netCents: 100000, dueOn: "2026-01-10", paidOn: "2026-01-11", ...o });
const KNOWN = new Set(["11222333000181"]);
const TODAY = "2026-10-24";
const kinds = (rows: StageRow[]) => analyze(rows, KNOWN, TODAY).divergences.map((d) => d.kind);

describe("H1 — análise do histórico da planilha (pura)", () => {
  it("linha limpa não gera divergência; por aba e por mês de pagamento", () => {
    const r = analyze([row(), row({ row: 6, name: "BETA", document: "12ABC34501DE35", documentRaw: "12.ABC.345/01DE-35", dueOn: "2026-01-20", paidOn: "2026-02-02", netCents: 100500 })], new Set(["11222333000181", "12ABC34501DE35"]), TODAY);
    expect(r.divergences.map((d) => d.kind)).toEqual(["liquido_diferente"]);
    expect(r.months).toEqual([{ month: "2026-01", rows: 2, billedCents: 200000, paidRows: 2, receivedCents: 200500, assumedRows: 0, assumedCents: 0, openRows: 0, openCents: 0, textRows: 0, textCents: 0 }]);
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
    expect(kinds([row({ paidOn: "2026-12-20" })])).toContain("pagamento_futuro");
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

  it("duplicidade: mesmo valor e vencimento = revisar; mesmo cliente com valores/vencimentos diferentes = só informativo; outra aba não conta", () => {
    expect(kinds([row(), row({ row: 9 })])).toEqual(["duplicado_no_mes", "duplicado_no_mes"]);
    expect(kinds([row(), row({ row: 9, amountCents: 50000, netCents: 50000 })])).toEqual(["varias_cobrancas_no_mes", "varias_cobrancas_no_mes"]);
    expect(kinds([row({ documentRaw: "", document: null, name: "Sem Doc" }), row({ row: 9, documentRaw: "", document: null, name: "SEM DOC", dueOn: "2026-01-20" })])).toEqual(["sem_documento", "sem_documento", "varias_cobrancas_no_mes", "varias_cobrancas_no_mes"]);
    expect(kinds([row(), row({ row: 9, month: "2026-02", dueOn: "2026-02-10", paidOn: "2026-02-11" })])).toEqual([]);
    const r = analyze([row(), row({ row: 9 })], KNOWN, TODAY); expect(r.toReview).toBe(2); expect(analyze([row(), row({ row: 9, amountCents: 1, netCents: 1 })], KNOWN, TODAY).toReview).toBe(0);
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

  it("formato americano (MM/DD): dia e mês trocados são detectados e corrigidos SÓ na análise", () => {
    expect(swapDayMonth("2026-05-01")).toBe("2026-01-05"); expect(swapDayMonth("2026-10-01")).toBe("2026-01-10"); expect(swapDayMonth("2026-05-30")).toBeNull(); expect(swapDayMonth("2026-12-12")).toBe("2026-12-12");
    // aba JAN: vencimento 05/01 lido como 1º de maio; pagamento 12/01 (Date certo)
    const r = analyze([row({ dueOn: "2026-05-01", paidOn: "2026-01-12" })], KNOWN, TODAY);
    expect(r.divergences.map((d) => d.kind)).toEqual(["data_invertida"]);
    expect(r.divergences[0].detail).toBe("vencimento 01/05/2026 → 05/01/2026");
    expect(r.months[0]).toMatchObject({ paidRows: 1, openRows: 0 }); expect(r.receivedByPayMonth[0].month).toBe("2026-01");
    expect(r.toReview).toBe(0); // corrigido: sem pendência
    // pagamento também invertido: 06/01 lido como 1º de junho (142 dias depois do vencimento corrigido)
    const p = analyze([row({ dueOn: "2026-10-01", paidOn: "2026-06-01" })], KNOWN, TODAY);
    expect(p.divergences.map((d) => d.detail)).toEqual(["vencimento 01/10/2026 → 10/01/2026; pagamento 01/06/2026 → 06/01/2026"]);
    expect(p.receivedByPayMonth[0].month).toBe("2026-01");
    // vencimento fora da aba que a troca NÃO explica continua sendo divergência para revisar
    expect(kinds([row({ month: "2026-06", dueOn: "2026-05-30", paidOn: null })])).toEqual(["vencimento_fora_da_aba"]);
    expect(kinds([row({ dueOn: "2026-05-10", paidOn: null })])).toEqual(["vencimento_fora_da_aba"]); // 10/05 trocado = 05/10: continua fora da aba JAN
    // pagamento SOZINHO nunca é trocado (só junto com o vencimento da mesma linha): data futura continua sendo divergência
    expect(kinds([row({ dueOn: "2026-01-10", paidOn: "2026-12-01" })])).toContain("pagamento_futuro");
    expect(kinds([row({ dueOn: "2026-01-10", paidOn: "2026-12-01" })])).not.toContain("data_invertida");
    // pagamento tardio de verdade (dia > 12: não é troca) segue como divergência
    expect(kinds([row({ dueOn: "2026-01-25", paidOn: "2026-09-30" })])).toEqual(["pagamento_muito_tardio"]);
    // pagamento normal nunca é "corrigido"
    expect(kinds([row({ dueOn: "2026-01-10", paidOn: "2026-01-05" })])).toEqual([]);
  });

  it("pagamento escrito como texto (dois pagamentos) vira divergência para revisar; fica como não pago", () => {
    const r = analyze([row({ paidOn: null, netCents: null, paidRaw: "24/03;14/04" })], KNOWN, TODAY);
    expect(r.divergences.map((d) => d.kind)).toEqual(["pagamento_em_texto"]);
    expect(r.months[0]).toMatchObject({ paidRows: 0, openRows: 0, textRows: 1, textCents: 100000 }); expect(r.totals).toMatchObject({ openCents: 0, textRows: 1 }); expect(r.toReview).toBe(1);
  });

  it("clientes a corrigir: agrupa por nome, sugere o CNPJ das outras linhas, o dos dígitos trocados e o do cadastro; correção registrada tira da lista", () => {
    const bad = (rowN: number, raw: string) => row({ row: rowN, month: "2026-02", dueOn: "2026-02-10", paidOn: "2026-02-11", name: "DB SUPERMERCADOS", documentRaw: raw, document: null });
    const ok = (rowN: number) => row({ row: rowN, name: "DB Supermercados", documentRaw: "22.991.939/0001-06", document: "22991939000106" });
    const r = analyze([bad(29, "22.991.939/0001-60"), bad(34, "22.991.939/0001-60"), ok(10), ok(11), row({ row: 50, name: "SEM DOC", documentRaw: "", document: null })], KNOWN, TODAY, new Map([["SEM DOC", "99999999000191"]]));
    expect(r.toFix.map((c) => [c.name, c.rows])).toEqual([["DB SUPERMERCADOS", 2], ["SEM DOC", 1]]);
    expect(r.toFix[0].rawDocuments).toEqual(["22.991.939/0001-60"]);
    expect(r.toFix[0].suggestions.map((s) => s.formatted)).toEqual(["22.991.939/0001-06"]); // das outras linhas (1ª) e dos dígitos trocados: sem repetir
    expect(r.toFix[0].suggestions[0].why).toMatch(/2 outra\(s\) linha/);
    expect(r.toFix[1].suggestions.map((s) => s.formatted)).toEqual(["99.999.999/0001-91"]);
    // com a correção aplicada pelo serviço (document preenchido + docFixed), sai da lista e vira informativo
    const fixed = analyze([{ ...bad(29, "22.991.939/0001-60"), document: "22991939000106", docFixed: true }, ok(10)], new Set(["22991939000106"]), TODAY);
    expect(fixed.toFix).toEqual([]); expect(fixed.counts.documento_invalido).toBe(0); expect(fixed.counts.documento_corrigido).toBe(1); expect(fixed.toReview).toBe(0);
  });
});

