import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/v1/health/route";

describe("health", () => {
  it("responde ok sem dados sensíveis", async () => {
    const body = await GET().json();
    expect(body).toEqual({ status: "ok" });
  });
});
