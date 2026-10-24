import { test, expect } from "@playwright/test";

test("E22 — conta de e-mail em Integrações: valida, guarda cifrada e nunca mostra usuário/senha", async ({ page }) => {
  await page.goto("/integracoes");
  await expect(page.getByRole("heading", { name: /E-mail \(SMTP\)/ })).toBeVisible();
  await page.getByLabel("Servidor SMTP").fill("10.0.0.5");
  await page.getByLabel("E-mail remetente").fill("financeiro@k3gsolutions.com.br");
  await page.getByLabel(/^Usuário SMTP/).fill("financeiro@k3gsolutions.com.br");
  await page.getByLabel(/^Senha SMTP/).fill("Senha-De-Teste-123");
  await page.getByRole("button", { name: "Guardar conta de e-mail" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "nome público" })).toBeVisible();

  await page.getByLabel("Servidor SMTP").fill("smtp.k3gsolutions.com.br");
  await page.getByLabel("Nome do remetente (opcional)").fill("K3G Solutions — Financeiro");
  await page.getByLabel(/^Usuário SMTP/).fill("financeiro@k3gsolutions.com.br");
  await page.getByLabel(/^Senha SMTP/).fill("Senha-De-Teste-123");
  await page.getByRole("button", { name: "Guardar conta de e-mail" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Conta de e-mail (guardada|atualizada)/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Configurada · smtp\.k3gsolutions\.com\.br:587/)).toBeVisible();
  await expect(page.getByText("Nenhum e-mail sai", { exact: false }).first()).toBeVisible();
  expect(await page.content()).not.toContain("Senha-De-Teste-123");
  expect(await page.locator("input[name=password]").inputValue()).toBe("");
  await expect(page.getByText("Conta cadastrada na seção «E-mail (SMTP)»", { exact: false })).toBeVisible();
});

test("E22 — Dados da empresa: contador e dados fiscais, com a lista do que falta", async ({ page }) => {
  await page.goto("/empresa");
  await expect(page.getByRole("heading", { name: "Contabilidade e dados fiscais" })).toBeVisible();
  await page.getByLabel("Nome do contador / escritório").fill("Escritório Contábil Teste");
  await page.getByLabel("CPF ou CNPJ").fill("11.111.111/1111-11");
  await page.getByRole("button", { name: "Salvar contabilidade e dados fiscais" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "CPF/CNPJ do contador inválido" })).toBeVisible();

  await page.goto("/empresa");
  await page.getByLabel("Nome do contador / escritório").fill("Escritório Contábil Teste");
  await page.getByLabel("E-mail", { exact: true }).fill("contador@contabil.com.br");
  await page.getByLabel("CNAE principal").fill("6190601");
  await page.getByLabel("Código do serviço (LC 116)").fill("1.07");
  await page.getByLabel("Alíquota do ISS (%)").fill("2,5");
  await page.getByRole("button", { name: "Salvar contabilidade e dados fiscais" }).click();
  await expect(page.getByText(/Salvo: .*CNAE/)).toBeVisible();
  await page.reload();
  await expect(page.getByText("Falta para a NFS-e:")).toBeVisible();
  await expect(page.getByLabel("Alíquota do ISS (%)")).toHaveValue("2,5");
  await expect(page.getByText("Guardar estes dados não emite nota", { exact: false })).toBeVisible();
});
