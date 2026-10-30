import { test, expect } from "@playwright/test";

test("W4 — régua de WhatsApp: nasce desligada, a chave do servidor aparece, ligar exige frase e uma régua, desligar é imediato; simulação não envia nada; painel dos 30 dias", async ({ page }) => {
  await test.step("sem a cobrança por WhatsApp liberada, a régua nem pode ser ligada", async () => {
    await page.goto("/whatsapp/regua");
    await expect(page.getByText("Antes, libere a cobrança por WhatsApp em Configuração.")).toBeVisible();
    await page.goto("/whatsapp/configuracao");                                                              // o e42 desliga no fim: libera aqui (e desliga no fim deste teste)
    await page.getByLabel("Onde está a autorização escrita da empresa").fill("ata da diretoria de 30/10/2026");
    await page.getByLabel(/Para confirmar, digite/).fill("ENVIAR WHATSAPP A CLIENTES");
    await page.getByRole("button", { name: "Liberar cobrança por WhatsApp" }).click();
    await expect(page.getByText("Liberada", { exact: true })).toBeVisible();
  });
  await page.goto("/whatsapp/regua");
  await expect(page.getByRole("heading", { name: "Régua e painel do WhatsApp" })).toBeVisible();
  await expect(page.getByText("não é um canal oficial")).toBeVisible();

  await test.step("situação: tudo desligado por padrão; a chave do servidor está desligada no sandbox", async () => {
    await expect(page.getByText("Desligada", { exact: true })).toBeVisible();
    await expect(page.getByText(/Chave de automação do servidor:/)).toContainText("desligada");
    await expect(page.getByText(/nada sai sozinho/).first()).toBeVisible();
  });

  await test.step("ligar: frase errada é recusada; sem escolher régua é recusado; com tudo certo liga («a partir de amanhã»)", async () => {
    const ref = () => page.getByLabel("Onde está a aprovação da diretoria para a régua automática");
    const phrase = () => page.getByLabel(/Para confirmar, digite/);
    await ref().fill("e-mail da diretoria de 30/10/2026"); await phrase().fill("ligar regua");
    await page.getByLabel("Vencimento (D0)").check();
    await page.getByRole("button", { name: "Ligar régua automática" }).click();
    await expect(page.getByText(/digite exatamente/)).toBeVisible();
    await ref().fill("e-mail da diretoria de 30/10/2026"); await phrase().fill("LIGAR RÉGUA DE WHATSAPP");   // o formulário limpa os campos depois de uma tentativa
    await page.getByRole("button", { name: "Ligar régua automática" }).click();
    await expect(page.getByText(/Escolha ao menos uma régua/)).toBeVisible();
    await ref().fill("e-mail da diretoria de 30/10/2026"); await phrase().fill("LIGAR RÉGUA DE WHATSAPP");
    await page.getByLabel("Vencimento (D0)").check();
    await page.getByRole("button", { name: "Ligar régua automática" }).click();
    await expect(page.getByText(/só começa a valer a partir de amanhã/)).toBeVisible();
    await expect(page.getByText("Régua da empresa:")).toContainText("ligada");
    await expect(page.getByText(/e-mail da diretoria de 30\/10\/2026/)).toBeVisible();
  });

  await test.step("simulação e painel: não enviam nada e explicam", async () => {
    await expect(page.getByRole("heading", { name: /Simulação do dia/ })).toBeVisible();
    await expect(page.getByText(/não envia nada/)).toBeVisible();
    await page.getByLabel("Dia").fill("2030-01-01");
    await page.getByRole("button", { name: "Simular" }).click();
    await expect(page.getByText(/Nenhuma cobrança em aberto cai em/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Números dos últimos 30 dias" })).toBeVisible();
    await expect(page.getByText(/não.* afirma que o aviso causou o pagamento/)).toBeVisible();
  });

  await test.step("desligar é imediato e deixa o estado como estava", async () => {
    await page.getByRole("button", { name: "Desligar régua automática" }).click();
    await expect(page.getByText(/Régua automática desligada/)).toBeVisible();
    await expect(page.getByText("Régua da empresa:")).toContainText("desligada");
  });

  await test.step("desligar a cobrança por WhatsApp da empresa também desliga a régua (e deixa o sandbox como estava)", async () => {
    await page.goto("/whatsapp/regua");
    await page.getByLabel("Onde está a aprovação da diretoria para a régua automática").fill("e-mail da diretoria de 30/10/2026");
    await page.getByLabel(/Para confirmar, digite/).fill("LIGAR RÉGUA DE WHATSAPP");
    await page.getByLabel("Lembrete D-3 (3 dias antes do vencimento)").check();
    await page.getByRole("button", { name: "Ligar régua automática" }).click();
    await expect(page.getByText("Régua da empresa:")).toContainText("ligada");
    await page.goto("/whatsapp/configuracao");
    await page.getByRole("button", { name: "Desligar cobrança por WhatsApp" }).click();
    await page.goto("/whatsapp/regua");
    await expect(page.getByText("Régua da empresa:")).toContainText("desligada");
    await expect(page.getByText("Antes, libere a cobrança por WhatsApp em Configuração.")).toBeVisible();
  });
});
