import { test, expect } from "@playwright/test";

test("Alertas de contratos — tela abre, janela é escolhida e o '?' leva ao artigo", async ({ page }) => {
  await page.goto("/contratos/alertas");
  await expect(page.getByRole("heading", { name: "Alertas de contratos" })).toBeVisible();
  await page.getByLabel("Avisar com antecedência de").selectOption("90");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/janela=90/);
  await expect(page.getByLabel("Avisar com antecedência de")).toHaveValue("90");
  await page.getByRole("link", { name: "Ajuda desta tela" }).click();
  await expect(page).toHaveURL(/\/ajuda\/alertas-de-contratos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Alertas de contratos" })).toBeVisible();
});
