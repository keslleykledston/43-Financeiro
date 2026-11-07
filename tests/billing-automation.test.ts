import { describe, expect, it } from "vitest";
import { candidateIssueDates, isBusinessDay, previewDateFor, runDateFor } from "@/modules/billing/automation";
import { holidaysFor } from "@/modules/billing/calendar";

const hol = (...d: string[]) => holidaysFor(d);

describe("faturamento automático — datas (puras)", () => {
  it("dia da emissão: a própria data se for dia útil; senão o dia útil ANTERIOR (nunca depois)", () => {
    const h = hol("2027-02-01", "2027-05-01", "2027-08-01", "2027-11-15");
    expect(runDateFor("2027-02-01", h)).toBe("2027-02-01"); // segunda
    expect(runDateFor("2027-05-01", h)).toBe("2027-04-30"); // sábado e feriado → sexta
    expect(runDateFor("2027-08-01", h)).toBe("2027-07-30"); // domingo → sexta
    expect(runDateFor("2027-11-15", h)).toBe("2027-11-12"); // Proclamação (segunda) → sexta anterior
    expect(isBusinessDay("2027-11-15", h)).toBe(false);
  });
  it("feriado da empresa também conta", () => {
    const h = holidaysFor(["2027-02-01"], new Map([["2027-02-01", "Aniversário da cidade"]]));
    expect(runDateFor("2027-02-01", h)).toBe("2027-01-29");
  });
  it("prévia pronta N dias ÚTEIS antes do dia da emissão", () => {
    const h = hol("2027-02-01");
    expect(previewDateFor("2027-02-01", 2, h)).toBe("2027-01-28"); // segunda − 2 úteis = quinta
    expect(previewDateFor("2027-02-01", 0, h)).toBe("2027-02-01");
    expect(previewDateFor("2027-02-03", 2, h)).toBe("2027-02-01");
  });
  it("datas de emissão candidatas: 1, 8, 15 e 25 do mês e do seguinte (virada de ano)", () => {
    expect(candidateIssueDates("2026-11-07")).toEqual(["2026-11-01", "2026-11-08", "2026-11-15", "2026-11-25", "2026-12-01", "2026-12-08", "2026-12-15", "2026-12-25"]);
    expect(candidateIssueDates("2026-12-20").slice(4)).toEqual(["2027-01-01", "2027-01-08", "2027-01-15", "2027-01-25"]);
  });
});
