import { describe, expect, it } from "vitest";
import { tooManyAttempts } from "@/lib/security/rate-limit";

describe("rate-limit de login", () => {
  it("bloqueia após o máximo e libera depois da janela", () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(tooManyAttempts("k", 5, 1000, t)).toBe(false);
    expect(tooManyAttempts("k", 5, 1000, t)).toBe(true);
    expect(tooManyAttempts("k", 5, 1000, t + 2000)).toBe(false);
  });
});
