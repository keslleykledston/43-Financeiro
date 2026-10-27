import { test, expect } from "@playwright/test";

test("relatório de despesas por categoria: abre, troca a base e oferece o CSV", async ({ page }) => {
  await page.goto("/contas-a-pagar");
  await page.getByRole("link", { name: "Despesas por categoria" }).click();
  await expect(page.getByRole("heading", { name: "Despesas por categoria" })).toBeVisible();
  await expect(page.getByText("Por categoria e mês")).toBeVisible();
  await expect(page.getByText("Por centro de custo e mês")).toBeVisible();
  await page.getByLabel("Contar por").selectOption("competencia");
  await page.getByRole("button", { name: "Ver" }).click();
  await expect(page.getByText(/contas aprovadas, pelo valor da conta/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Baixar CSV" })).toBeVisible();
  const r = await page.request.get("/contas-a-pagar/relatorio/exportar?base=pago");
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("text/csv");
});
