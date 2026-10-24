import { test, expect } from "@playwright/test";

test("H1 — Histórico: tela abre (sem importação mostra orientação), não altera nada e o '?' leva ao artigo", async ({ page }) => {
  await page.goto("/historico");
  await expect(page.getByRole("heading", { name: "Histórico da planilha" })).toBeVisible();
  await expect(page.getByText("Esta tela só lê e mede", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Nada importado ainda|Importação/ })).toBeVisible();
  await page.getByRole("link", { name: "Ajuda desta tela" }).click();
  await expect(page).toHaveURL(/\/ajuda\/historico-da-planilha$/);
  await expect(page.getByRole("heading", { level: 1, name: "Histórico da planilha de boletos" })).toBeVisible();
  const csv = await page.request.get("/historico/exportar");
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("tipo;gravidade;aba;linha");
});
