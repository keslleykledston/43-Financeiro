import { test, expect } from "@playwright/test";

// Chave do servidor DESLIGADA no sandbox: aqui se prova a tela, o registro da autorização e que NADA é enviado.
test("E23 — envio real de e-mail (canário): autorização registrada, teste recusado com a chave desligada, banner continua de validação", async ({ page }) => {
  await page.goto("/integracoes");
  await expect(page.getByRole("heading", { name: "Envio real — canário" })).toBeVisible();
  await expect(page.getByText("Chave do servidor:")).toBeVisible();
  await expect(page.getByText("desligada").first()).toBeVisible();
  await expect(page.getByText("VALIDAÇÃO", { exact: false }).first()).toBeVisible();

  await page.getByText(/Registrar autorização|Substituir a autorização/).first().click();
  await page.getByLabel("Referência da autorização escrita").fill("e-mail da diretoria de 25/10/2026");
  await page.getByLabel(/^Quem pode receber/).fill("@gmail.com");
  await page.getByRole("button", { name: "Registrar autorização" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "só é aceito para o domínio do remetente" })).toBeVisible();

  await page.getByLabel("Referência da autorização escrita").fill("e-mail da diretoria de 25/10/2026");
  await page.getByLabel(/^Quem pode receber/).fill("@k3gsolutions.com.br");
  await page.getByRole("button", { name: "Registrar autorização" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Autorização registrada. Nada foi enviado" })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Autorização: ativa/)).toBeVisible();

  await page.getByLabel("Enviar e-mail de teste para").fill("alguem@k3gsolutions.com.br");
  await page.getByRole("button", { name: "Enviar teste" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "desligado no servidor" })).toBeVisible();
  await expect(page.getByText("Últimos envios reais")).toHaveCount(0); // nada foi tentado

  await page.getByRole("button", { name: "Revogar autorização" }).click();
  await expect(page.getByText(/Autorização:\s*nenhuma/)).toBeVisible();
});
