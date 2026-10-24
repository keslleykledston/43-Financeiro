import { test, expect } from "@playwright/test";

test("Cadastro de cliente: validador de CNPJ ao vivo, com sugestão do provável erro (…-60 → …-06)", async ({ page }) => {
  await page.goto("/clientes/novo");
  const doc = page.getByLabel("CPF ou CNPJ");
  await doc.fill("22.991.939/0001");
  await expect(page.getByText("Faltam dígitos (12 informados).")).toBeVisible();
  await doc.fill("22.991.939/0001-60");
  await expect(page.getByText(/dígitos verificadores do CNPJ não conferem/)).toBeVisible();
  await page.getByRole("button", { name: "22.991.939/0001-06" }).click();
  await expect(doc).toHaveValue("22.991.939/0001-06");
  await expect(page.getByText("CNPJ válido: 22.991.939/0001-06")).toBeVisible();
});
