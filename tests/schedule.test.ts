import { describe, expect, it } from "vitest";
import { addMonths, dueDateIn, firstOf, isMonth, monthOf, seriesSchedule } from "@/modules/payables/schedule";

describe("D2 — datas de recorrências e parcelas", () => {
  it("dia 31 vira o último dia dos meses curtos, inclusive fevereiro de ano bissexto", () => {
    expect(dueDateIn("2026-02", 31)).toBe("2026-02-28");
    expect(dueDateIn("2028-02", 31)).toBe("2028-02-29");
    expect(dueDateIn("2026-04", 31)).toBe("2026-04-30");
    expect(dueDateIn("2026-01", 31)).toBe("2026-01-31");
    expect(dueDateIn("2026-10", 5)).toBe("2026-10-05");
  });
  it("soma meses atravessando o ano", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 12)).toBe("2027-12");
  });
  it("parcelas mantêm o dia do primeiro vencimento (com ajuste de mês curto) e não derivam", () => {
    expect(seriesSchedule("2026-01-31", 4)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]); // março volta ao 31, não ao 28
    expect(seriesSchedule("2026-10-14", 3)).toEqual(["2026-10-14", "2026-11-14", "2026-12-14"]);
    expect(seriesSchedule("2026-11-15", 37).at(-1)).toBe("2029-11-15");
  });
  it("valida mês e deriva primeiro dia", () => {
    expect(isMonth("2026-10")).toBe(true); expect(isMonth("2026-13")).toBe(false); expect(isMonth("2026-1")).toBe(false);
    expect(firstOf("2026-10")).toBe("2026-10-01"); expect(monthOf("2026-10-25")).toBe("2026-10");
  });
});
