import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// .pfx de TESTE pré-gerado (fixtures/nfse-cert): o e2e roda sem as dependências do app
const PFX = readFileSync(path.resolve(__dirname, "../fixtures/nfse-cert/teste-e2e.pfx"));

test("N2b-0 — Integrações: cartão do certificado A1 recusa arquivo errado, senha errada e CNPJ de outra empresa, sem vazar nada", async ({ page }) => {
  await page.goto("/integracoes");
  const card = page.locator("section", { has: page.getByRole("heading", { name: /Certificado digital A1/ }) });
  await expect(card).toBeVisible();
  await expect(card.getByText(/importar aqui não emite nota nem liga nada/i)).toBeVisible();
  await expect(card.getByLabel("Senha do certificado")).toHaveAttribute("type", "password");
  await expect(card.getByLabel("Senha do certificado")).toHaveAttribute("autocomplete", "new-password");

  const envia = async (name: string, buffer: Buffer, senha: string) => {
    await card.locator('input[name="pfx"]').setInputFiles({ name, mimeType: "application/x-pkcs12", buffer });
    await card.getByLabel("Senha do certificado").fill(senha);
    await card.getByRole("button", { name: /Importar certificado|Substituir certificado/ }).click();
  };

  await test.step("arquivo que não é .pfx", async () => {
    await envia("nota.pfx", Buffer.from("isto é só texto, não é um certificado ".repeat(10)), "qualquer");
    await expect(card.getByRole("alert")).toContainText(/não é um certificado/);
  });
  await test.step("senha errada", async () => {
    await envia("empresa.pfx", PFX, "errada-456");
    await expect(card.getByRole("alert")).toContainText(/Senha do certificado incorreta|Cadastre antes o CNPJ/);
  });
  await test.step("certificado de outro CNPJ (ou empresa sem CNPJ) é recusado e nada é guardado", async () => {
    await envia("outra.pfx", PFX, "certa-123"); // o CNPJ do certificado de teste (11.222.333/0001-81) não é o da empresa do e2e
    await expect(card.getByRole("alert")).toContainText(/não é o desta empresa|Cadastre antes o CNPJ/);
    await expect(card.getByRole("status")).toHaveCount(0); // nenhuma mensagem de sucesso
    await expect(card.getByText(/Nenhum certificado guardado/)).toBeVisible();
    await page.reload();
    await expect(page.locator("body")).not.toContainText("certa-123");
  });
});
