import { describe, expect, it } from "vitest";
import type { Cell, Sheet } from "@/modules/contracts/planilha";
import { installmentOf, readExpenseWorkbook } from "@/modules/expenses/planilha";
import { recurringCandidates, seriesCandidates, suggest, vendorKeyOf } from "@/modules/expenses/classify";

const D = (m: number, d: number) => new Date(Date.UTC(2026, m - 1, d));
// aba fictícia no mesmo formato: empresa (A–F), casa (H–M), faturas (O–Q) e dízimos (S–W)
const head: Cell[][] = [
  ["DESPESAS - EMPRESA - ABRIL / 2026", null, null, null, null, null, null, "DESPESAS - CASA", null, null, null, null, null, null, "CARTÕES DE CRÉDITO", null, null, null, "OFERTAS E DÍZIMOS", null, null, null, null],
  ["QUANT.", "VENC.", "DESCRIÇÃO", "VALOR", null, "DATA/PG", null, "QUANT.", "VENC.", "DESCRIÇÃO", "VALOR", "VALOR / PG", "DATA/PG", null, "VENC.", "DESCRIÇÃO", "VALOR", null, "DATA", "VALOR = 10%", "DATA", "OFERTAS/DÍZIMOS", "VALOR"],
];
const row = (e: Cell[], c: Cell[], k: Cell[] = [], z: Cell[] = []): Cell[] => { const r: Cell[] = Array(23).fill(null); e.forEach((v, i) => (r[i] = v)); c.forEach((v, i) => (r[7 + i] = v)); k.forEach((v, i) => (r[14 + i] = v)); z.forEach((v, i) => (r[20 + i] = v)); return r; };
const abr: Sheet = { name: " DESPESAS  ABR 2026", rows: [...head,
  row([1, D(4, 3), "VIVO CORPORATIVO", 773.56, 773.56, D(4, 6)], [1, D(4, 3), "ÁGUA", 224.19, 224.19, D(4, 6)], [D(3, 9), "NUBANK", 1747.69], []),
  row([2, D(4, 3), "EMPRESTIMO / K3G2 / 14/36", 4170.03, 3000, "19/04"], [2, D(4, 5), "CARRO 23/48", 2617.79, 2617.79, D(4, 17)], [D(3, 10), "CAIXA ELO PJ", 4906.14], []),
  row([3, D(4, 5), "AMAZON", null, null, null], [3, D(4, 5), "CARTÃO BRADESCO", 2100, "-", null], [D(4, 1), "SÁLARIO / FUNCIONÁRIOS", 100], [D(4, 9), "Elizabete", 1000]),
  row([null, null, "TOTAL", 5000, 3773.56], [null, null, "TOTAL", 4000, 3000]),
  row([null, null, "DESPESAS CASA", 3000], []),
] };
const mai: Sheet = { name: " DESPESAS  MAI 2026", rows: [...head, row([1, D(5, 3), "VIVO CORPORATIVO", 773.56, 773.56, D(5, 5)], []), row([2, D(5, 3), "EMPRESTIMO / K3G2 / 15/36", 4170.03, 4170.03, D(5, 14)], [])] };
const jun: Sheet = { name: "DESPESAS JUN 2026", rows: [...head, row([1, D(6, 3), "VIVO CORPORATIVO", 789.22, 789.22, D(6, 3)], []), row([2, D(6, 3), "EMPRESTIMO / K3G2 / 16/36", 4217.04, 4217.04, D(6, 14)], [])] };

describe("D3 — leitor da planilha de despesas (dados fictícios)", () => {
  const rows = readExpenseWorkbook([abr, mai, jun, { name: "RESUMO", rows: [["x"]] }], 2026);

  it("separa os blocos, ignora TOTAL/resumo e a aba sem mês", () => {
    const a = rows.filter((r) => r.month === "2026-04");
    expect(a.filter((r) => r.block === "empresa").map((r) => r.description)).toEqual(["VIVO CORPORATIVO", "EMPRESTIMO / K3G2 / 14/36", "AMAZON"]);
    expect(a.filter((r) => r.block === "casa").map((r) => r.description)).toEqual(["ÁGUA", "CARRO 23/48", "CARTÃO BRADESCO"]);
    expect(rows.some((r) => /TOTAL|DESPESAS CASA/.test(r.description))).toBe(false);
    expect(rows.every((r) => ["2026-04", "2026-05", "2026-06"].includes(r.month))).toBe(true);
  });
  it("valores em centavos, datas completas e texto de pagamento fora de data", () => {
    const viva = rows.find((r) => r.month === "2026-04" && r.description === "VIVO CORPORATIVO")!;
    expect(viva).toMatchObject({ block: "empresa", row: 3, dueOn: "2026-04-03", amountCents: 77356, paidCents: 77356, paidOn: "2026-04-06", paidRaw: null });
    const emp = rows.find((r) => r.description.startsWith("EMPRESTIMO") && r.month === "2026-04")!;
    expect(emp).toMatchObject({ amountCents: 417003, paidCents: 300000, paidOn: null, paidRaw: "19/04", installmentNo: 14, installmentsTotal: 36 });
    const amazon = rows.find((r) => r.description === "AMAZON")!;
    expect(amazon).toMatchObject({ amountCents: null, paidCents: null, paidOn: null });
    expect(rows.find((r) => r.description === "CARTÃO BRADESCO")).toMatchObject({ amountCents: 210000, paidCents: null }); // "-" = sem valor pago
  });
  it("faturas de cartão e dízimos são blocos próprios; a mini-tabela de colaboradores não vira fatura", () => {
    const k = rows.filter((r) => r.block === "cartao");
    expect(k.map((r) => r.description)).toEqual(["NUBANK", "CAIXA ELO PJ"]);
    expect(k[0]).toMatchObject({ dueOn: "2026-03-09", amountCents: 174769 });
    expect(rows.filter((r) => r.block === "dizimo")).toEqual([expect.objectContaining({ description: "Elizabete", amountCents: 100000, dueOn: "2026-04-09" })]);
  });
  it("duas abas com o mesmo nome não repetem a posição (evita violar o índice único na importação)", () => {
    const twin = readExpenseWorkbook([{ name: "DESPESAS ABR 2026", rows: abr.rows }, { name: " DESPESAS ABR 2026", rows: abr.rows }], 2026);
    const keys = twin.map((r) => `${r.sheet}|${r.row}|${r.block}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("parcela só vale n ≤ N e N ≥ 2 (data como 19/02 não é parcela)", () => {
    expect(installmentOf("CARRO 20/48")).toEqual({ no: 20, total: 48 });
    expect(installmentOf("PAGO 19/02")).toBeNull();
    expect(installmentOf("RELÓGIO 1/1")).toBeNull();
    expect(installmentOf("SEM PARCELA")).toBeNull();
  });
});

describe("D3 — sugestão de classificação, recorrências e parcelas", () => {
  const s = (block: "empresa" | "casa" | "cartao" | "dizimo", description: string) => suggest({ block, description });
  it("empresa: folha, impostos, operação, financeiro; Call e K3G 2 viram dicas", () => {
    expect(s("empresa", "SÁLARIO / FUNCIONÁRIOS").categoryCode).toBe("salarios");
    expect(s("empresa", "VT + VA").categoryCode).toBe("vt_va");
    expect(s("empresa", "FGTS / CALL")).toMatchObject({ categoryCode: "fgts", companyHint: "call" });
    expect(s("empresa", "FGTS / 13º SALARIO").categoryCode).toBe("fgts");
    expect(s("empresa", "FÉRIAS / ALGUÉM").categoryCode).toBe("ferias_13");
    expect(s("empresa", "RESCISÃO / ALGUÉM").categoryCode).toBe("rescisoes");
    expect(s("empresa", "DARF: IRRF / INSS").categoryCode).toBe("inss_irrf");
    expect(s("empresa", "SIMPLES N. CALL")).toMatchObject({ categoryCode: "simples", companyHint: "call" });
    expect(s("empresa", "EMPRESTIMO / K3G2 / 10º")).toMatchObject({ categoryCode: "emprestimos", centerHint: "k3g2" });
    expect(s("empresa", "EMPRESTIMO GIRO/CAIXA 13º").categoryCode).toBe("emprestimos"); // não confunde o 13º com décimo terceiro
    expect(s("empresa", "ENERGIA K3G 2")).toMatchObject({ categoryCode: "energia", centerHint: "k3g2" });
    expect(s("empresa", "IPTU K3G2 /")).toMatchObject({ categoryCode: "iptu_taxas", centerHint: "k3g2" });
    expect(s("empresa", "MEDINA 30% SET").categoryCode).toBe("comissoes");
    expect(s("empresa", "INTERNET / DB/ BOA VISTA").categoryCode).toBe("telecom");
    expect(s("empresa", "FLOWBIX").categoryCode).toBe("software");
    expect(s("empresa", "CAIXA ELO PJ")).toMatchObject({ categoryCode: "cartao_pj", ambiguous: expect.stringContaining("sem detalhe") });
    expect(s("empresa", "CONSÓRCIO CARRO")).toMatchObject({ categoryCode: "consorcio", ambiguous: expect.stringContaining("de quem") });
    expect(s("empresa", "CARREFOUR")).toMatchObject({ categoryCode: "a_classificar", ambiguous: expect.any(String) });
    expect(s("empresa", "COISA ESTRANHA")).toMatchObject({ categoryCode: "a_classificar", nature: "empresa", ambiguous: null });
  });
  it("casa: sempre retirada; cartão pessoal, veículos, educação, moradia, presentes; sem regra vira 'a classificar'", () => {
    expect(s("casa", "ÁGUA")).toMatchObject({ categoryCode: "moradia", nature: "retirada" });
    expect(s("casa", "NUBANK")).toMatchObject({ categoryCode: "cartao_pf", ambiguous: expect.any(String) });
    expect(s("casa", "CARRO 23/48").categoryCode).toBe("veiculos_pessoais");
    expect(s("casa", "FACULDADE FULANO").categoryCode).toBe("educacao");
    expect(s("casa", "PRESENTE / ALGUÉM 1/4").categoryCode).toBe("presentes");
    expect(s("casa", "ELETRICA IGREJA").categoryCode).toBe("a_classificar_pessoal");
    expect(s("dizimo", "Elizabete")).toMatchObject({ categoryCode: "dizimos", nature: "retirada" });
    expect(s("cartao", "NUBANK")).toMatchObject({ nature: "referencia" });
  });
  it("chave do fornecedor tira parcela, ordinal e números", () => {
    expect(vendorKeyOf("EMPRESTIMO / K3G2 / 14/36")).toBe("EMPRESTIMO K3G2");
    expect(vendorKeyOf("EMPRÉSTIMO CAIXA 28/37")).toBe("EMPRESTIMO CAIXA");
    expect(vendorKeyOf("EMPRESTIMO GIRO/CAIXA 13º")).toBe("EMPRESTIMO GIRO CAIXA");
  });
  const mk = (month: string, description: string, cents: number | null, day = 3, block: "empresa" | "casa" = "empresa", inst?: [number, number]) => ({ sheet: "s", row: 1, month, block, description, dueOn: `${month}-${String(day).padStart(2, "0")}`, amountCents: cents, paidCents: cents, paidOn: null, paidRaw: null, installmentNo: inst?.[0] ?? null, installmentsTotal: inst?.[1] ?? null });
  it("recorrentes: ≥3 meses, valor estável, sem parcela; instável e parcelas ficam de fora", () => {
    const rows = [
      ...["2026-01", "2026-02", "2026-03", "2026-04"].map((m, i) => mk(m, "VIVO CORPORATIVO", 77356 + i * 100)),
      ...["2026-01", "2026-02", "2026-03"].map((m, i) => mk(m, "CARTÃO VARIÁVEL", [10000, 90000, 30000][i])),
      ...["2026-01", "2026-02"].map((m) => mk(m, "SÓ DOIS MESES", 5000)),
      ...["2026-01", "2026-02", "2026-03"].map((m, i) => mk(m, `CARRO ${20 + i}/48`, 261779, 17, "casa", [20 + i, 48])),
    ];
    const r = recurringCandidates(rows);
    expect(r.map((x) => x.vendorKey)).toEqual(["VIVO CORPORATIVO"]);
    expect(r[0]).toMatchObject({ months: 4, typicalDay: 3, block: "empresa", categoryCode: "telecom", firstMonth: "2026-01", lastMonth: "2026-04" });
  });
  it("ordinal que continua como n/N do mesmo fornecedor vira uma série só; ordinal solto não é recorrente", () => {
    const rows = [mk("2026-01", "EMPRESTIMO / K3G2 / 10º", 385061), mk("2026-02", "EMPRESTIMO / K3G2 / 11º", 403753), mk("2026-03", "EMPRESTIMO / K3G2 / 12º", 407783), mk("2026-04", "EMPRESTIMO / K3G2 / 13º", 412502),
      mk("2026-05", "EMPRESTIMO / K3G2 / 14/36", 417003, 14, "empresa", [14, 36]), mk("2026-06", "EMPRESTIMO / K3G2 / 15/36", 421704, 14, "empresa", [15, 36])];
    expect(seriesCandidates(rows).map((s) => [s.sample, s.total, s.remaining])).toEqual([["EMPRESTIMO / K3G2 / 15/36", 36, 21]]);
    expect(recurringCandidates(rows)).toEqual([]);
  });
  it("séries: n/N com quanto resta; ordinal sem total conhecido; série concluída some", () => {
    const rows = [
      ...[18, 19].map((n, i) => mk(`2026-0${9 + i}`.replace("2026-010", "2026-10"), "EMPRESTIMO / K3G2", 440893, 14, "empresa", [n, 36])),
      mk("2026-10", "EMPRESTIMO GIRO/CAIXA 21º", 194616), mk("2026-09", "EMPRESTIMO GIRO/CAIXA 20º", 194616),
      mk("2026-10", "EMPRÉSTIMO CAIXA", 238348, 17, "empresa", [37, 37]),
    ];
    const s = seriesCandidates(rows);
    expect(s.map((x) => x.vendorKey)).toEqual(["EMPRESTIMO K3G2", "EMPRESTIMO GIRO CAIXA"]);
    expect(s[0]).toMatchObject({ lastNo: 19, total: 36, remaining: 17, remainingCents: 17 * 440893, unknownTotal: false });
    expect(s[1]).toMatchObject({ lastNo: 21, total: null, remaining: null, unknownTotal: true, installmentCents: 194616 });
  });
});
