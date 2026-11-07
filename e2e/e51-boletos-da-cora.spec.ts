import { test, expect } from "@playwright/test";

test("F1b — Boletos da Cora: tela de acompanhamento (espelho), aviso de que nada é cobrado sozinho, filtros e acesso pela Contas a receber", async ({ page }) => {
  await page.goto("/contas-a-receber");
  await page.getByRole("link", { name: "Boletos da Cora" }).click();
  await expect(page.getByRole("heading", { name: "Boletos da Cora" })).toBeVisible();
  await expect(page.getByText(/Nenhuma cobrança automática sai a partir deles/)).toBeVisible();
  for (const t of ["Em atraso", "A vencer", "Pagos", "Cancelados"]) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("Situação")).toHaveValue("atrasados");
  await page.getByLabel("Situação").selectOption("todos");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page).toHaveURL(/filtro=todos/);
  await expect(page.getByRole("button", { name: "Atualizar agora" })).toBeVisible();
  await expect(page.getByText(/Nenhum boleto neste filtro/)).toBeVisible(); // sandbox: nada importado (a Cora de produção nunca é tocada)
});
