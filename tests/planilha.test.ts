import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import readXlsxFile from "read-excel-file/node";
import { brl, cents, consolidate, dayOf, monthOfSheet, readWorkbook, toContractCsv, type Cell, type Sheet } from "@/modules/contracts/planilha";
import { parseCsv } from "@/lib/csv";

// fixtures/planilha-ficticia.xlsx: planilha INVENTADA no mesmo formato da real (abas JAN–MAR + uma aba ignorada)
const load = async (): Promise<Sheet[]> => (await readXlsxFile(resolve("fixtures/planilha-ficticia.xlsx"))).map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }));

describe("planilha de boletos → contratos (dados fictícios)", () => {
  it("converte valores, dias e meses", () => {
    expect(cents(1000)).toBe(100000);
    expect(cents(2000.5)).toBe(200050);
    expect(cents("R$ 1.234,56")).toBe(123456);
    expect(cents("")).toBeNull();
    expect(cents(-5)).toBeNull();
    expect(dayOf(new Date(Date.UTC(2026, 0, 14)))).toBe(14);
    expect(dayOf("14/01/2026")).toBe(14);
    expect(dayOf("2026-01-14")).toBe(14);
    expect(dayOf(46036)).toBe(14); // 14/01/2026 em série do Excel
    expect(dayOf("abc")).toBeNull();
    expect(monthOfSheet("JAN", 2026)).toBe("2026-01");
    expect(monthOfSheet("Out", 2026)).toBe("2026-10");
    expect(monthOfSheet("RESUMO", 2026)).toBeNull();
    expect(brl(120000)).toBe("1.200,00");
    expect(brl(5)).toBe("0,05");
  });

  it("lê as abas do arquivo .xlsx, separa os blocos e ignora TOTAL e abas sem mês", async () => {
    const entries = readWorkbook(await load(), 2026);
    expect(entries.filter((e) => e.block === "solutions")).toHaveLength(14); // JAN 5 + FEV 5 + MAR 4
    expect(entries.filter((e) => e.block === "call")).toHaveLength(6);
    expect(entries.some((e) => /TOTAL/i.test(e.name))).toBe(false);
    const alfaJan = entries.find((e) => e.block === "solutions" && e.month === "2026-01" && e.name === "ALFA REDES LTDA")!;
    expect(alfaJan).toMatchObject({ grossCents: 100000, dueDay: 10, service: "Link dedicado", email: "fin@alfa.example", contact: "Ana", obs: "medina" });
    const callFev = entries.find((e) => e.block === "call" && e.month === "2026-02" && e.name === "ALFA REDES LTDA")!;
    expect(callFev).toMatchObject({ planoCents: 79800, excedenteCents: 12000 });
  });

  it("consolida: valor do mês mais recente, vencimento mais comum, parceiro, vigência", async () => {
    const all = consolidate(readWorkbook(await load(), 2026));
    const sol = (n: string) => all.find((c) => c.block === "solutions" && c.name === n)!;
    const call = (n: string) => all.find((c) => c.block === "call" && c.name === n)!;
    expect(sol("ALFA REDES LTDA")).toMatchObject({ monthlyCents: 120000, dueDay: 10, commissionPartner: "Medina", months: 3, distinctValues: 2, startAt: "2026-01-01", endAt: null, description: "Link dedicado", email: "fin@alfa.example" });
    expect(sol("BETA TELECOM SA")).toMatchObject({ monthlyCents: 200050, dueDay: 5, commissionPartner: "" });
    expect(sol("GAMA NET").endAt).toBe("2026-02-28"); // sumiu da última aba
    expect(sol("DELTA SEM CNPJ")).toMatchObject({ document: null, documentRaw: "" });
    expect(sol("EPSILON CNPJ RUIM")).toMatchObject({ document: null, documentRaw: "11.111.111/1111-11" });
    expect(call("ALFA REDES LTDA")).toMatchObject({ monthlyCents: 79800, description: "Plano K3G Call + excedente", hasExcedente: true });
    expect(call("OMEGA CALL")).toMatchObject({ monthlyCents: 152000, description: "Plano K3G Call", hasExcedente: false });
    // o mesmo CNPJ nos dois blocos continua sendo dois contratos (empresas diferentes)
    expect(all.filter((c) => c.name === "ALFA REDES LTDA")).toHaveLength(2);
  });

  it("gera o CSV de importação com cabeçalho esperado", async () => {
    const all = consolidate(readWorkbook(await load(), 2026));
    const t = parseCsv(toContractCsv(all.filter((c) => c.block === "solutions")));
    expect(t[0]).toEqual(["razao_social", "documento", "servico", "valor_mensal", "dia_vencimento", "inicio", "fim", "email_financeiro", "contato", "parceiro_comissao"]);
    const alfa = t.find((r) => r[0] === "ALFA REDES LTDA")!;
    expect(alfa.slice(1)).toEqual(["10020030000113", "Link dedicado", "1.200,00", "10", "2026-01-01", "", "fin@alfa.example", "Ana", "Medina"]);
    expect(t).toHaveLength(6); // cabeçalho + 5 clientes da Solutions
  });

  it("layout sem títulos nem coluna QUANT.: ainda separa pelos blocos CLIENTE", () => {
    const rows: Cell[][] = [
      ["VENCIMENTO", "CLIENTE", "CNPJ", "VALOR BRUTO", "SERVIÇO", "CLIENTE", "CNPJ", "Plano", "Excedente"],
      [new Date(Date.UTC(2026, 0, 7)), "UM", "10.020.030/0001-13", 100, "svc", "DOIS", "20.030.040/0001-93", 50, 5],
    ];
    const e = readWorkbook([{ name: "JAN", rows }], 2026);
    expect(e.map((x) => [x.block, x.name, x.dueDay])).toEqual([["solutions", "UM", 7], ["call", "DOIS", null]]);
  });
});
