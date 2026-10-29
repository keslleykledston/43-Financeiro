import { test, expect } from "@playwright/test";

test("W3a — WhatsApp cobrança: liberar a empresa (frase obrigatória), modelos padrão, histórico vazio e a tela de envio com prévia e lista de verificação", async ({ page }) => {
  await test.step("configuração nasce desligada; ligar exige referência e a frase exata", async () => {
    await page.goto("/whatsapp/configuracao");
    await expect(page.getByRole("heading", { name: "Configuração do WhatsApp" })).toBeVisible();
    await expect(page.getByText("não é um canal oficial")).toBeVisible();
    await expect(page.getByText("Desligada", { exact: true })).toBeVisible();
    await page.getByLabel("Onde está a autorização escrita da empresa").fill("ata da diretoria de 29/10/2026");
    await page.getByLabel(/Para confirmar, digite/).fill("enviar whatsapp");
    await page.getByRole("button", { name: "Liberar cobrança por WhatsApp" }).click();
    await expect(page.getByText(/digite exatamente/)).toBeVisible();
    await page.getByLabel("Onde está a autorização escrita da empresa").fill("ata da diretoria de 29/10/2026"); // o formulário limpa os campos depois de uma tentativa
    await page.getByLabel(/Para confirmar, digite/).fill("ENVIAR WHATSAPP A CLIENTES");
    await page.getByRole("button", { name: "Liberar cobrança por WhatsApp" }).click();
    await expect(page.getByText("Configuração salva")).toBeVisible();
    await expect(page.getByText("Liberada", { exact: true })).toBeVisible();
    await expect(page.getByText("ata da diretoria de 29/10/2026")).toBeVisible();
  });

  await test.step("modelos padrão de WhatsApp: curtos, sem boleto, com a saída PARAR", async () => {
    await page.getByRole("button", { name: "Criar/atualizar modelos padrão" }).click();
    await expect(page.getByText("Modelos de WhatsApp conferidos/criados")).toBeVisible();
    await expect(page.getByText(/responda PARAR/).first()).toBeVisible();
    await expect(page.getByText(/linha_digitavel|indisponível/)).toHaveCount(0);
  });

  await test.step("histórico começa vazio e explica como enviar", async () => {
    await page.goto("/whatsapp/historico");
    await expect(page.getByRole("heading", { name: "Histórico de WhatsApp" })).toBeVisible();
    await expect(page.getByText("Nenhuma mensagem ainda")).toBeVisible();
    await expect(page.getByText(/nunca é reenviada sozinha/)).toBeVisible();
  });

  await test.step("sem cobrança escolhida, a tela de envio orienta; com uma cobrança aberta mostra prévia e lista, e o botão trava por falta de consentimento/contato", async () => {
    await page.goto("/whatsapp/enviar");
    await expect(page.getByText("Abra uma cobrança em")).toBeVisible();
    await page.goto("/contas-a-receber");
    const link = page.locator("a[href^='/contas-a-receber/']").first();
    if (await link.count()) {
      await link.click();
      const enviar = page.getByRole("link", { name: "Enviar por WhatsApp" });
      if (await enviar.count()) {
        await enviar.click();
        await expect(page.getByRole("heading", { name: "Cobrança por WhatsApp" })).toBeVisible();
        const list = page.getByRole("list", { name: "Lista de verificação do envio" });
        await expect(list.getByText("Cobrança em aberto")).toBeVisible();
        await expect(list.getByLabel("bloqueado").first()).toBeVisible();            // sem consentimento/contato/conexão no sandbox
        await expect(page.getByRole("button", { name: "Colocar na fila" })).toBeDisabled();
      }
    }
  });

  await test.step("desligar é imediato e a ajuda existe", async () => {
    await page.goto("/whatsapp/configuracao");
    await page.getByRole("button", { name: "Desligar cobrança por WhatsApp" }).click();
    await expect(page.getByText("Configuração salva")).toBeVisible();
    await expect(page.getByText("Desligada", { exact: true })).toBeVisible();
    await page.goto("/ajuda/whatsapp-cobranca");
    await expect(page.getByRole("heading", { name: /WhatsApp: cobrar clientes/ })).toBeVisible();
  });
});
