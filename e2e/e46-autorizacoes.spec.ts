import { test, expect } from "@playwright/test";

test("A1 — painel único de autorizações: tudo desligado, chaves de emergência do servidor avisam, WhatsApp liga e desliga com 1 clique", async ({ page }) => {
  await page.goto("/autorizacoes");
  await expect(page.getByRole("heading", { name: "Autorizações" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Autorizações" })).toBeVisible(); // aba em Configurações

  await test.step("seis funções, todas desligadas por padrão", async () => {
    for (const t of ["Faturamento automático", "Boletos reais (Cora)", "E-mail para clientes", "E-mail do sistema (senha e convites)", "WhatsApp para clientes", "Régua automática de WhatsApp"]) await expect(page.getByRole("switch", { name: new RegExp(t.replace(/[()]/g, "\\$&")) })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(6);
    for (const sw of await page.getByRole("switch").all()) await expect(sw).toHaveAttribute("aria-checked", "false");
  });

  await test.step("onde o servidor está com a chave de emergência desligada, a chave não liga e o motivo aparece", async () => {
    await expect(page.getByText("A emissão em produção está desligada neste servidor (chave de emergência).")).toBeVisible();
    await expect(page.getByText("O envio de e-mail está desligado neste servidor (chave de emergência).")).toHaveCount(2); // clientes e sistema
    await expect(page.getByText("A régua automática está desligada neste servidor (chave de emergência).")).toBeVisible();
    await expect(page.getByRole("switch", { name: /Boletos reais \(Cora\): ligar/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /E-mail para clientes: ligar/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /E-mail do sistema \(senha e convites\): ligar/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /Régua automática de WhatsApp: ligar/ })).toBeDisabled();
  });

  await test.step("WhatsApp: UM clique liga (limite por dia), um clique desliga; fica no registro de atividades", async () => {
    await page.getByRole("switch", { name: /WhatsApp para clientes: ligar/ }).click();
    await expect(page.getByText("WhatsApp LIGADO.")).toBeVisible();
    await expect(page.getByRole("switch", { name: /WhatsApp para clientes: desligar/ })).toHaveAttribute("aria-checked", "true");
    await page.getByLabel(/Limite por dia \(1 a 10\)/).fill("4");
    await page.getByRole("listitem").filter({ hasText: "WhatsApp para clientes" }).getByRole("button", { name: "Salvar limite" }).click();
    await expect(page.getByText("Limite de WhatsApp salvo.")).toBeVisible();
    await expect(page.getByLabel(/Limite por dia \(1 a 10\)/)).toHaveValue("4");
    await page.screenshot({ path: "e2e-results/shots/desktop-autorizacoes.png", fullPage: true });
    await page.getByRole("switch", { name: /WhatsApp para clientes: desligar/ }).click();
    await expect(page.getByText("WhatsApp DESLIGADO (a régua também).")).toBeVisible();
    await expect(page.getByRole("switch", { name: /WhatsApp para clientes: ligar/ })).toHaveAttribute("aria-checked", "false");
    await page.goto("/auditoria?q=authorization");
    await expect(page.getByText("Ligou/desligou uma função no painel de autorizações").first()).toBeVisible();
  });
});
