import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDps, dhEmi, dpsId, dpsProblems, DpsIncomplete, xsdText, type DpsInput } from "@/modules/nfse/dps";

// O XSD oficial 1.01 traz `^0{0,4}\d{1,5}$` em TSSerieDPS; em XSD `^` e `$` são caracteres LITERAIS, então nenhuma série numérica passa. Validamos numa CÓPIA com só essa regra corrigida (a do v1.00 era `0{0,4}\d{1,5}`); o original em fixtures/ fica intacto.
const SRC = path.resolve(__dirname, "../fixtures/nfse-xsd/1.01");
const XSD_DIR = mkdtempSync(path.join(tmpdir(), "nfse-xsd-"));
cpSync(SRC, XSD_DIR, { recursive: true });
{
  const f = path.join(XSD_DIR, "tiposSimples_v1.01.xsd"), t = readFileSync(f, "utf8");
  if (!t.includes('value="^0{0,4}\\d{1,5}$"')) throw new Error("o XSD mudou: rever a correção da série no teste");
  writeFileSync(f, t.replace('value="^0{0,4}\\d{1,5}$"', 'value="0{0,4}\\d{1,5}"'));
}
const XSD = path.join(XSD_DIR, "DPS_v1.01.xsd");
function validate(xml: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "dps-"));
  const f = path.join(dir, "dps.xml");
  try {
    writeFileSync(f, xml);
    try { return { ok: true, out: execFileSync("xmllint", ["--noout", "--schema", XSD, f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
    catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string };
      if (err.code === "ENOENT") throw new Error("xmllint não instalado na imagem de testes (libxml2-utils): a validação contra o XSD NÃO pode ser pulada");
      return { ok: false, out: String(err.stderr ?? err.message) };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const base = (over: Partial<DpsInput> = {}): DpsInput => ({
  environment: 2, emittedAt: new Date("2026-11-04T15:30:00Z"), appVersion: "k3gfinance-n2a", series: 1, number: 7, competenceDate: "2026-10-01",
  provider: { cnpj: "11222333000181", municipalRegistration: "12345", regime: "simples", issRateBps: 200, issWithheld: false, cityIbge: "1302603", tribNacCode: "010701" },
  customer: { document: "45723174000110", name: "Cliente Exemplo LTDA", address: { cityIbge: "1302603", cep: "69000000", street: "Rua A", number: "10", complement: null, district: "Centro" } },
  service: { description: "Suporte técnico mensal – outubro/2026", amountCents: 1350000 },
  ...over,
});

describe("DPS Padrão Nacional 1.01", () => {
  it("Id tem 45 posições: DPS + município(7) + tipo(1) + inscrição(14) + série(5) + número(15)", () => {
    const id = dpsId("1302603", "11222333000181", 1, 7);
    expect(id).toBe("DPS13026032" + "11222333000181" + "00001" + "000000000000007");
    expect(id).toHaveLength(45);
    expect(dpsId("1302603", "12345678909", 1, 7).slice(10, 11)).toBe("1"); // CPF
  });
  it("dhEmi em Manaus (-04:00), sem horário de verão", () => { expect(dhEmi(new Date("2026-11-04T15:30:00Z"))).toBe("2026-11-04T11:30:00-04:00"); expect(dhEmi(new Date("2026-11-04T02:00:00Z"))).toBe("2026-11-03T22:00:00-04:00"); });

  const cases: [string, DpsInput][] = [
    ["Simples ME/EPP com endereço", base()],
    ["MEI sem inscrição municipal", base({ provider: { ...base().provider, regime: "mei", municipalRegistration: null } })],
    ["Lucro presumido, ISS retido, alíquota 5%", base({ provider: { ...base().provider, regime: "presumido", issRateBps: 500, issWithheld: true } })],
    ["Lucro real, alíquota 0%", base({ provider: { ...base().provider, regime: "real", issRateBps: 0 } })],
    ["tomador pessoa física, sem endereço", base({ customer: { document: "123.456.789-09", name: "Fulano de Tal", address: null } })],
    ["endereço incompleto não entra", base({ customer: { ...base().customer, address: { cityIbge: "1302603", cep: "69000000", street: "Rua A", number: "", complement: null, district: "Centro" } } })],
    ["texto com & < > aspas, travessão, emoji e várias linhas", base({ service: { description: "Serviço “A” & <B> – 5 > 3\n\n\nLinha 2 😀   com   espaços  ", amountCents: 5 }, customer: { ...base().customer, name: "Empresa  D’Água & Cia – ME " } })],
    ["valor alto", base({ service: { description: "x", amountCents: 99_999_999_999_99 } })],
    ["série 0 e número grande", base({ series: 0, number: 999_999_999_999_999 })],
  ];
  for (const [name, input] of cases) {
    it(`valida no XSD oficial: ${name}`, () => {
      const { xml, id } = buildDps(input);
      const v = validate(xml);
      expect(v.ok, v.out).toBe(true);
      expect(xml).toContain(`Id="${id}"`);
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    });
  }

  it("o validador realmente reprova XML fora do leiaute (sanidade do teste)", () => {
    const { xml } = buildDps(base());
    expect(validate(xml.replace("<tpEmit>1</tpEmit>", "<tpEmit>9</tpEmit>")).ok).toBe(false);
  });

  it("mapeamento do regime e dos campos de tributação", () => {
    const x = (o: Partial<DpsInput["provider"]>) => buildDps(base({ provider: { ...base().provider, ...o } })).xml;
    expect(x({ regime: "mei" })).toContain("<opSimpNac>2</opSimpNac><regEspTrib>0</regEspTrib>");
    expect(x({ regime: "simples" })).toContain("<opSimpNac>3</opSimpNac><regEspTrib>0</regEspTrib>"); expect(x({ regime: "simples" })).not.toContain("regApTribSN");
    expect(x({ regime: "presumido", issRateBps: 250 })).toContain("<opSimpNac>1</opSimpNac>");
    expect(x({ regime: "presumido", issRateBps: 250 })).toContain("<pAliq>2.50</pAliq>");
    expect(x({ regime: "simples" })).not.toContain("pAliq"); // optante do Simples não informa alíquota
    expect(x({ issWithheld: true })).toContain("<tpRetISSQN>2</tpRetISSQN>");
    expect(x({})).toContain("<tpRetISSQN>1</tpRetISSQN>");
    expect(x({})).toContain("<tpAmb>2</tpAmb>");
  });

  it("valor em reais com 2 casas, sem arredondar errado", () => {
    expect(buildDps(base({ service: { description: "x", amountCents: 5 } })).xml).toContain("<vServ>0.05</vServ>");
    expect(buildDps(base({ service: { description: "x", amountCents: 1350000 } })).xml).toContain("<vServ>13500.00</vServ>");
    expect(buildDps(base({ service: { description: "x", amountCents: 1_234_567 } })).xml).toContain("<vServ>12345.67</vServ>");
  });

  it("endereço incompleto do tomador gera aviso e some do XML", () => {
    const r = buildDps(base({ customer: { ...base().customer, address: null } }));
    expect(r.warnings.join(" ")).toMatch(/Endereço do cliente incompleto/);
    expect(r.xml).not.toContain("<end>");
    const w = (o: Partial<DpsInput["provider"]>) => buildDps(base({ provider: { ...base().provider, ...o } })).warnings.join(" | ");
    expect(w({ regime: "simples" })).toMatch(/regApTribSN/);
    expect(w({ regime: "presumido", issRateBps: 200 })).toMatch(/parametrizada/);
    expect(w({ regime: "mei", issWithheld: true })).toMatch(/retido pelo tomador/);
    expect(w({ regime: "mei" })).toBe("");
  });

  it("recusa DPS incompleta listando tudo que falta (em português)", () => {
    const bad = base({ provider: { ...base().provider, cnpj: "", regime: null, cityIbge: null, tribNacCode: "1.07" }, customer: { document: "123", name: " ", address: null }, service: { description: "", amountCents: 0 }, competenceDate: "2026-02-30" });
    const m = dpsProblems(bad);
    for (const t of ["CNPJ da empresa", "regime tributário", "IBGE", "tributação nacional", "CPF/CNPJ do cliente", "razão social do cliente", "descrição do serviço", "valor do serviço", "data de competência"]) expect(m.join("|")).toContain(t);
    expect(() => buildDps(bad)).toThrow(DpsIncomplete);
  });
  it("lucro presumido/real sem alíquota é recusado; Simples/MEI não precisam", () => {
    expect(dpsProblems(base({ provider: { ...base().provider, regime: "presumido", issRateBps: null } })).join()).toContain("alíquota");
    expect(dpsProblems(base({ provider: { ...base().provider, regime: "simples", issRateBps: null } }))).toEqual([]);
  });
  it("competência futura e CNPJ alfanumérico são recusados", () => {
    expect(dpsProblems(base({ competenceDate: "2026-12-01" })).join()).toContain("competência no futuro");
    expect(dpsProblems(base({ provider: { ...base().provider, cnpj: "12ABC34501DE35" } })).join()).toContain("CNPJ da empresa");
  });

  it("xsdText: Latin-1 imprimível, sem espaços nas pontas, limite de tamanho", () => {
    expect(xsdText("  “Olá” – ção 😀  ", 50)).toBe('"Olá" - ção ?');
    expect(xsdText("a\n\n\n\nb", 50, true)).toBe("a\n\nb");
    expect(xsdText("a\nb", 50)).toBe("a b");
    expect(xsdText("abcdef", 3)).toBe("abc");
    expect(xsdText("abc ", 4)).toBe("abc");
    expect(xsdText(null, 5)).toBe("");
  });
});
