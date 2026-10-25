import { test, expect } from "@playwright/test";

test("D3 — histórico de despesas: tela abre vazia, explica que só lê e os CSV respondem", async ({ page }) => {
  await page.goto("/historico");
  await page.getByRole("link", { name: "Histórico de despesas" }).click();
  await expect(page.getByRole("heading", { name: "Histórico de despesas" })).toBeVisible();
  await expect(page.getByText(/só lê.* e sugere/)).toBeVisible();
  await expect(page.getByText("Nada importado ainda")).toBeVisible();
  for (const o of ["classificacao", "divergencias"]) {
    const r = await page.request.get(`/historico/despesas/exportar?o=${o}`);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/csv");
  }
});
