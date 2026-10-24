import { test, expect } from "@playwright/test";

test("Ajuda — lista de artigos, artigo renderizado e o '?' do cabeçalho abre o artigo da tela", async ({ page }) => {
  await page.goto("/ajuda");
  await expect(page.getByRole("heading", { name: "Ajuda" })).toBeVisible();
  await page.getByRole("link", { name: "Importar contratos da planilha" }).click();
  await expect(page).toHaveURL(/\/ajuda\/importar-contratos$/);
  await expect(page.getByRole("heading", { name: "Importar contratos da planilha", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Passo a passo" })).toBeVisible();

  await page.goto("/contas-a-pagar");
  await page.getByRole("link", { name: "Ajuda desta tela" }).click();
  await expect(page).toHaveURL(/\/ajuda\/contas-a-pagar$/);
  await expect(page.getByRole("heading", { level: 1, name: /pagar/i })).toBeVisible();

  // slug inexistente / travessia: 404, nunca um arquivo
  const r = await page.goto("/ajuda/..%2Fpackage");
  expect(r?.status()).toBe(404);
});
