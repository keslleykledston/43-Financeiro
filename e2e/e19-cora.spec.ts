import { test, expect } from "@playwright/test";
import { ENCRYPTED_KEY, TEST_CERT, TEST_KEY } from "../tests/fixtures/cora-teste";

test("E19 — Cora: escopo só de boletos, credenciais guardadas cifradas, sem mostrar de volta", async ({ page }) => {
  await page.goto("/integracoes");
  const sec = page.locator("section", { has: page.getByRole("heading", { name: "Cora — boletos" }) });
  await expect(sec).toBeVisible();
  await expect(sec.getByText("Emitir boleto", { exact: true })).toBeVisible();
  await expect(sec.getByText(/Pagar contas ou boletos/)).toBeVisible();
  await expect(sec.getByText(/Transferir ou enviar Pix/)).toBeVisible();
  await expect(sec.getByText("Nenhuma credencial guardada").first()).toBeVisible();

  await test.step("chave com senha é recusada e nada é guardado", async () => {
    await sec.getByLabel("Client ID").fill("int-teste-e2e-123");
    await sec.getByLabel("Certificado (.pem / .crt)").fill(TEST_CERT);
    await sec.getByLabel("Chave privada (.pem / .key)").fill(ENCRYPTED_KEY);
    await sec.getByRole("button", { name: "Guardar credenciais" }).click();
    await expect(sec.getByRole("alert")).toContainText("protegida por senha");
    await expect(sec.getByText("Nenhuma credencial guardada").first()).toBeVisible();
  });

  await test.step("credenciais válidas são guardadas; só impressão digital e validade aparecem", async () => {
    await sec.getByLabel("Apelido da conta (opcional)").fill("Conta de teste");
    await sec.getByLabel("Client ID").fill("int-teste-e2e-123");
    await sec.getByLabel("Certificado (.pem / .crt)").fill(TEST_CERT);
    await sec.getByLabel("Chave privada (.pem / .key)").fill(TEST_KEY);
    await sec.getByRole("button", { name: "Guardar credenciais" }).click();
    await expect(sec.getByRole("status")).toContainText("Credenciais guardadas");
    await expect(sec.getByText(/Configurado · Conta de teste/)).toBeVisible();
    const html = await page.content();
    const keyBody = TEST_KEY.split("\n")[1]; // um trecho do corpo da chave (o cabeçalho aparece no placeholder do campo)
    expect(keyBody.length).toBeGreaterThan(20);
    expect(html).not.toContain(keyBody);
    expect(html).not.toContain(TEST_CERT.split("\n")[1]);
    expect(html).not.toContain("int-teste-e2e-123");
    await expect(sec.getByLabel("Chave privada (.pem / .key)")).toHaveValue("");
  });

  await test.step("o checklist reconhece as credenciais, mas a emissão real segue bloqueada", async () => {
    const item = page.locator("li", { hasText: "Credenciais Cora (client-id, certificado e chave mTLS)" });
    await expect(item.getByText("OK", { exact: true })).toBeVisible();
    const auth = page.locator("li", { hasText: "Autorização explícita da diretoria" });
    await expect(auth.getByText("Pendente")).toBeVisible();
  });

  await test.step("remover apaga", async () => {
    await sec.getByRole("button", { name: "Remover" }).click();
    await expect(sec.getByText("Nenhuma credencial guardada").first()).toBeVisible();
    await expect(sec.getByRole("button", { name: "Remover" })).toHaveCount(0);
  });
});
