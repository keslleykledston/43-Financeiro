import { describe, expect, it } from "vitest";
import fixture from "../fixtures/billing_calendar_cases.json";
import { addMonths, billingSchedule, daysInMonth, nationalHolidays } from "@/modules/billing/calendar";
import { MAX_CENTS, centsFromNumeric, numericFromCents, parseMoneyToCents } from "@/lib/money";

type Case = { competenceMonth: string; dueDate?: string; dueDay?: number; dueMonth?: string; jointInvoice: boolean; issueDate?: string; review: boolean; reason?: string };

describe("calendário pós-pago — fixture oficial do pacote (12 casos)", () => {
  for (const c of fixture.cases as Case[]) {
    const dueDay = c.dueDay ?? Number(c.dueDate!.slice(8, 10));
    it(`${c.competenceMonth} · vence dia ${dueDay} · NF conjunta=${c.jointInvoice}`, () => {
      const r = billingSchedule({ competenceMonth: c.competenceMonth, dueDay, jointInvoice: c.jointInvoice });
      expect(r.review).toBe(c.review);
      expect(r.dueDate).toBe(c.dueDate);       // undefined quando exige revisão (dia 31 / mês curto)
      expect(r.issueDate).toBe(c.issueDate);
      if (c.reason) expect(r.reason).toBe(c.reason);
    });
  }
});

describe("calendário — regras e bordas (E04: dias 1, 5, 12, 13, 16, 17, 22, 23, 30, 31, virada de ano, fevereiro)", () => {
  const s = (competenceMonth: string, dueDay: number, jointInvoice = false, issueDayOverride?: number) => billingSchedule({ competenceMonth, dueDay, jointInvoice, issueDayOverride });

  it("faixas de vencimento → dia de emissão e lote", () => {
    const tab: [number, boolean, string, 25 | 1 | 8 | 15][] = [
      [1, false, "2026-10-25", 25], [5, false, "2026-10-25", 25], [12, false, "2026-10-25", 25],
      [1, true, "2026-11-01", 1], [5, true, "2026-11-01", 1], [12, true, "2026-11-01", 1],
      [13, false, "2026-11-01", 1], [16, false, "2026-11-01", 1], [17, false, "2026-11-08", 8], [22, false, "2026-11-08", 8], [23, false, "2026-11-15", 15], [30, false, "2026-11-15", 15],
    ];
    for (const [d, j, issue, batch] of tab) { const r = s("2026-10", d, j); expect([d, j, r.issueDate, r.batch]).toEqual([d, j, issue, batch]); }
  });
  it("competência M, vencimento M+1; virada de ano e dezembro→janeiro", () => {
    expect(s("2026-12", 10).dueDate).toBe("2027-01-10");
    expect(s("2026-12", 10).issueDate).toBe("2026-12-25"); // 25 do mês anterior ao vencimento
    expect(s("2026-01", 20).dueDate).toBe("2026-02-20");
    expect(addMonths("2026-12", 1)).toBe("2027-01"); expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
  it("dia 31 sempre exige revisão e não inventa datas", () => {
    for (const m of ["2026-10", "2026-12", "2027-01"]) { const r = s(m, 31); expect(r).toMatchObject({ review: true, reason: "dia 31 não possui lote confirmado" }); expect(r.dueDate).toBeUndefined(); expect(r.issueDate).toBeUndefined(); }
  });
  it("mês curto: 29 e 30 em fevereiro (ano comum) exigem revisão; 29/fev em ano bissexto existe", () => {
    expect(s("2027-01", 29).review).toBe(true); expect(s("2027-01", 29).dueDate).toBeUndefined(); expect(s("2027-01", 29).reason).toMatch(/dia 29 não existe em fevereiro/);
    expect(s("2027-01", 30).reason).toBe("dia 30 não existe em fevereiro; política pendente");
    expect(daysInMonth("2028-02")).toBe(29);
    expect(s("2028-01", 29)).toMatchObject({ review: false, dueDate: "2028-02-29", issueDate: "2028-02-15" });
    expect(s("2027-01", 28)).toMatchObject({ review: false, dueDate: "2027-02-28" });
  });
  it("feriado em DIA ÚTIL na emissão exige revisão; em fim de semana é só aviso (igual à fixture)", () => {
    expect(s("2026-12", 5)).toMatchObject({ review: true, issueDate: "2026-12-25", reason: "feriado; política pendente" }); // Natal, sexta
    expect(s("2026-10", 5)).toMatchObject({ review: false, issueDate: "2026-10-25" });                                       // domingo
    expect(s("2026-10", 5).warnings).toContain("emissao_fim_de_semana");
    const extra = new Map([["2026-10-26", "Feriado municipal fictício"]]);               // feriado cadastrado pela empresa
    expect(billingSchedule({ competenceMonth: "2026-09", dueDay: 26, jointInvoice: false }, new Map([["2026-10-15", "x"]]))).toMatchObject({ issueDate: "2026-10-15", review: true });
    expect(extra.size).toBe(1);
  });
  it("avisos: vencimento em fim de semana/feriado e emissão no dia do vencimento", () => {
    expect(s("2026-10", 1, true).warnings).toContain("emissao_no_dia_do_vencimento"); // vence 01/11 e emite 01/11
    expect(s("2026-10", 14).dueDate).toBe("2026-11-14");                                                              // sábado
    expect(s("2026-10", 14).warnings).toEqual(expect.arrayContaining(["vencimento_fim_de_semana", "emissao_fim_de_semana"]));
    expect(s("2026-10", 16).warnings).not.toContain("vencimento_fim_de_semana");                                      // 16/11/2026 é segunda
    expect(s("2026-10", 15, false).dueDate).toBe("2026-11-15");
    expect(s("2026-10", 15).warnings).toContain("vencimento_feriado");                // Proclamação da República
  });
  it("dia de emissão personalizado: aplica no mês do vencimento; depois do vencimento exige revisão", () => {
    expect(s("2026-10", 20, false, 10)).toMatchObject({ issueDate: "2026-11-10", batch: null, review: false });
    expect(s("2026-10", 5, false, 10)).toMatchObject({ review: true, reason: "dia de emissão informado é posterior ao vencimento" });
    expect(() => s("2026-10", 20, false, 29)).toThrow(/emissão inválido/);
  });
  it("entradas inválidas são rejeitadas", () => {
    expect(() => s("2026-13", 5)).toThrow(/mês inválido/); expect(() => s("2026-10", 0)).toThrow(/vencimento inválido/); expect(() => s("2026-10", 32)).toThrow(); expect(() => s("2026-10", 1.5)).toThrow();
  });
  it("feriados nacionais: fixos e Sexta-feira Santa (Páscoa 2026 = 05/04 → 03/04)", () => {
    const h = nationalHolidays(2026);
    expect(h.get("2026-12-25")).toBe("Natal"); expect(h.get("2026-04-03")).toBe("Sexta-feira Santa"); expect(h.get("2027-03-26")).toBeUndefined();
    expect(nationalHolidays(2027).get("2027-03-26")).toBe("Sexta-feira Santa"); // Páscoa 2027 = 28/03
  });
});

describe("dinheiro em centavos", () => {
  it("P1 Codex: dinheiro fora do teto seguro é recusado na entrada e falha alto na leitura/escrita", () => {
    expect(parseMoneyToCents("99.999.999.999,99")).toBe(MAX_CENTS);
    expect(parseMoneyToCents("100.000.000.000,00")).toBeNull();
    expect(parseMoneyToCents("99999999999999999999")).toBeNull();
    expect(centsFromNumeric("99999999999.99")).toBe(MAX_CENTS);
    expect(() => centsFromNumeric("9999999999999999.99")).toThrow(RangeError); // numeric(18,2) aceitaria; Number perderia precisão
    expect(() => centsFromNumeric("abc")).toThrow(RangeError);
    expect(() => numericFromCents(MAX_CENTS + 1)).toThrow(RangeError);
    expect(() => numericFromCents(1.5)).toThrow(RangeError);
    expect(() => numericFromCents(-1)).toThrow(RangeError);
    expect(numericFromCents(MAX_CENTS)).toBe("99999999999.99");
  });

  it("entrada pt-BR estrita", () => {
    expect(parseMoneyToCents("2.500,00")).toBe(250000); expect(parseMoneyToCents("R$ 1.234,56")).toBe(123456); expect(parseMoneyToCents("2500")).toBe(250000);
    expect(parseMoneyToCents("0,5")).toBe(50); expect(parseMoneyToCents("2.500")).toBe(250000);
    for (const bad of ["2500.50", "1,234,56", "abc", "", "-10", "1.23,45", "10,123"]) expect(parseMoneyToCents(bad)).toBeNull();
  });
  it("numeric(18,2) ↔ centavos sem ponto flutuante", () => {
    expect(centsFromNumeric("2500.00")).toBe(250000); expect(centsFromNumeric("0.05")).toBe(5); expect(centsFromNumeric("19.9")).toBe(1990);
    expect(numericFromCents(250000)).toBe("2500.00"); expect(numericFromCents(5)).toBe("0.05"); expect(numericFromCents(1234567)).toBe("12345.67");
    expect(centsFromNumeric(numericFromCents(999999999))).toBe(999999999);
  });
});

describe("formulário: valor exibido é aceito de volta pelo parser", () => {
  it("2.500,00 / 0,05 / 1.234.567,89 fazem ida e volta", () => {
    const fmt = (c: number) => (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    for (const c of [250000, 5, 123456789, 100, 99]) expect(parseMoneyToCents(fmt(c))).toBe(c);
  });
});
