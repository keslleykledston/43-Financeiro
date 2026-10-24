import { describe, expect, it } from "vitest";
import { formatDate } from "@/lib/format";

describe("formatDate", () => {
  it("data de calendário (só dia) não sofre conversão de fuso", () => {
    expect(formatDate("2026-01-01")).toBe("01/01/2026");
    expect(formatDate("2026-12-31")).toBe("31/12/2026");
  });
  it("instante é mostrado no fuso de Manaus", () => {
    expect(formatDate("2026-01-01T02:00:00Z")).toBe("31/12/2025"); // 22h do dia anterior em Manaus (UTC-4)
    expect(formatDate(new Date("2026-06-01T12:00:00Z"))).toBe("01/06/2026");
  });
});
