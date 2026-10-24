import { describe, expect, it } from "vitest";
import { commissionCents, parsePercent, payDateOf, percentLabel, previousMonth } from "@/modules/commissions/calc";

describe("comissões — cálculo puro", () => {
  it("comissão = base × percentual, arredondada ao centavo (metade para cima)", () => {
    expect(commissionCents(250000, 3000)).toBe(75000);        // 30% de 2.500,00
    expect(commissionCents(100001, 3000)).toBe(30000);        // 300,003 → 300,00
    expect(commissionCents(100005, 3000)).toBe(30002);        // 300,015 → 300,02 (meio sobe)
    expect(commissionCents(1, 5000)).toBe(1);                 // 0,5 centavo → 1
    expect(commissionCents(1, 4999)).toBe(0);
    expect(commissionCents(9_999_999_999_999, 10000)).toBe(9_999_999_999_999); // sem estourar 2^53
    expect(commissionCents(9_999_999_999_999, 9999)).toBe(9_998_999_999_999);
  });

  it("rejeita base ou percentual inválidos", () => {
    for (const [b, p] of [[0, 3000], [-1, 3000], [1.5, 3000], [100, 0], [100, 10001], [100, 12.5]] as const) expect(() => commissionCents(b, p)).toThrow(RangeError);
  });

  it("lê percentual digitado", () => {
    expect(parsePercent("30")).toBe(3000);
    expect(parsePercent(" 30% ")).toBe(3000);
    expect(parsePercent("12,5")).toBe(1250);
    expect(parsePercent("12.55")).toBe(1255);
    expect(parsePercent("100")).toBe(10000);
    expect(parsePercent("0,01")).toBe(1);
    for (const bad of ["", "0", "0,00", "100,01", "101", "-5", "abc", "12,555", "1e2", "30%%"]) expect(parsePercent(bad)).toBeNull();
    expect(percentLabel(3000)).toBe("30%");
    expect(percentLabel(1250)).toBe("12,5%");
  });

  it("datas: mês anterior e dia 16 do mês seguinte (inclusive virada de ano)", () => {
    expect(previousMonth("2026-10-16")).toBe("2026-09");
    expect(previousMonth("2026-01-05")).toBe("2025-12");
    expect(payDateOf("2026-09")).toBe("2026-10-16");
    expect(payDateOf("2026-12")).toBe("2027-01-16");
  });
});
