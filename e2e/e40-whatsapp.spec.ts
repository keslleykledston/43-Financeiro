import { test, expect } from "@playwright/test";

const WAHA = process.env.FAKE_WAHA_URL ?? "http://waha:3000";
const KEY = process.env.FAKE_WAHA_KEY ?? "sandbox-waha-key";
const H = { "X-Api-Key": KEY };

test("W1 — WhatsApp: conectar por QR, liberar, registrar autorização, conferir a lista de verificação e enviar o teste (WAHA falsa)", async ({ page, request }) => {
  await request.post(`${WAHA}/__test/reset`, { headers: H });

  await test.step("janela de envio aberta o dia todo (o teste não depende do relógio)", async () => {
    await page.goto("/mensagens/configuracao");
    await page.getByLabel("Início").fill("00:00");
    await page.getByLabel("Fim").fill("23:59");
    for (const d of ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]) await page.getByLabel(d, { exact: true }).check();
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await expect(page.getByText("Configuração salva")).toBeVisible();
  });

  await test.step("tela de conexões: aviso de risco, chaves do servidor e menu", async () => {
    await page.goto("/whatsapp");
    await expect(page.getByRole("heading", { name: "WhatsApp", level: 1 })).toBeVisible();
    await expect(page.getByText("não é um canal oficial")).toBeVisible();
    await expect(page.getByText("Módulo ligado")).toBeVisible();
    await expect(page.getByText("Automações desligadas")).toBeVisible();
    await expect(page.getByRole("link", { name: "WhatsApp" }).first()).toBeVisible();
  });

  await test.step("criar a conexão exige a confirmação de autorização e mostra o QR", async () => {
    await page.getByLabel("Nome interno da conexão").fill("Financeiro e2e");
    await page.getByRole("button", { name: "Conectar WhatsApp" }).click(); // sem confirmar: o navegador barra (required)
    await expect(page.getByText("Conexão criada")).toHaveCount(0);
    await page.getByLabel(/Confirmo que tenho autorização/).check();
    await page.getByRole("button", { name: "Conectar WhatsApp" }).click();
    await expect(page.getByText("Conexão criada")).toBeVisible();
    await page.goto("/whatsapp");
    const card = page.locator("section", { hasText: "Financeiro e2e" }).first();
    await expect(card.getByText("Nasce").or(card.getByText("Pausada"))).toBeVisible();
    await expect(card.getByRole("img", { name: "QR Code para conectar o WhatsApp" })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId("wa-live-status")).toHaveText("Aguardando leitura do QR");
    await expect(card.getByRole("button", { name: "Liberar envios" })).toBeDisabled(); // não libera antes de conectar
  });

  await test.step("a leitura do QR muda a situação sozinha para Conectada, com o número mascarado", async () => {
    const list = await (await request.get(`${WAHA}/api/sessions`, { headers: H })).json();
    expect(list).toHaveLength(1);
    await request.post(`${WAHA}/__test/connect`, { headers: H, data: { name: list[0].name, phone: "5592988887777" } });
    const card = page.locator("section", { hasText: "Financeiro e2e" }).first();
    await expect(card.getByTestId("wa-live-status")).toHaveText("Conectada", { timeout: 25_000 });
    await page.goto("/whatsapp");
    await expect(page.getByText("+55 92 •••••-7777")).toBeVisible();
    await expect(page.getByRole("img", { name: "QR Code para conectar o WhatsApp" })).toHaveCount(0);
    await page.getByRole("button", { name: "Liberar envios" }).click();
    await expect(page.getByText("Conexão liberada para envios")).toBeVisible();
  });

  await test.step("teste: sem autorização o botão fica travado e a lista diz por quê", async () => {
    await page.goto("/whatsapp/teste");
    await expect(page.getByRole("heading", { name: "Enviar teste de WhatsApp" })).toBeVisible();
    await page.getByLabel("Conexão", { exact: true }).first().selectOption({ label: "Financeiro e2e" });
    await page.getByLabel("Número de destino").first().fill("92 99999-0000");
    await page.getByRole("button", { name: "Conferir" }).click();
    const list = page.getByRole("list", { name: "Lista de verificação do envio" });
    await expect(list.getByText("Registre a autorização")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar mensagem de teste" })).toBeDisabled();
  });

  await test.step("registrar a autorização (números mascarados na tela) e conferir tudo verde", async () => {
    await page.getByLabel("Referência da autorização escrita").fill("e-mail da diretoria de 29/10/2026");
    await page.getByLabel(/Números que podem receber/).fill("92 99999-0000");
    await page.getByRole("button", { name: "Registrar autorização" }).click();
    await expect(page.getByText("Autorização registrada. Nada foi enviado")).toBeVisible();
    await expect(page.getByText("+55 92 •••••-0000").first()).toBeVisible();
    await page.getByLabel("Conexão", { exact: true }).first().selectOption({ label: "Financeiro e2e" });
    await page.getByLabel("Número de destino").first().fill("(92) 99999-0000");
    await page.getByRole("button", { name: "Conferir" }).click();
    const list = page.getByRole("list", { name: "Lista de verificação do envio" });
    await expect(list.getByLabel("bloqueado")).toHaveCount(0);
    await expect(list.getByLabel("ok").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar mensagem de teste" })).toBeEnabled();
  });

  await test.step("número fora da lista é bloqueado e a lista mostra o motivo", async () => {
    await page.getByLabel("Número de destino").first().fill("92 98888-1111");
    await page.getByRole("button", { name: "Conferir" }).click();
    await expect(page.getByRole("list", { name: "Lista de verificação do envio" }).getByText("Só números da autorização")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar mensagem de teste" })).toBeDisabled();
  });

  await test.step("enviar: confirmação obrigatória; a WAHA recebe só o texto fixo na conversa individual; histórico mascarado", async () => {
    await page.getByLabel("Número de destino").first().fill("92 99999-0000");
    await page.getByRole("button", { name: "Conferir" }).click();
    await page.getByLabel(/Confirmo que este número é meu/).check();
    await page.getByRole("button", { name: "Enviar mensagem de teste" }).click();
    await expect(page.getByText("Teste enviado")).toBeVisible();
    const sent = await (await request.get(`${WAHA}/__test/sent`, { headers: H })).json();
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("5592999990000@c.us");
    expect(sent[0].text).toContain("Teste do K3G Finance");
    await page.goto("/whatsapp/teste");
    const table = page.getByRole("table");
    await expect(table.getByText("+55 92 •••••-0000")).toBeVisible();
    await expect(table.getByText("enviado")).toBeVisible();
  });

  await test.step("pausar a conexão trava o envio na hora", async () => {
    await page.goto("/whatsapp");
    await page.getByRole("button", { name: "Pausar envios" }).click();
    await expect(page.getByText("Conexão pausada")).toBeVisible();
    await page.goto("/whatsapp/teste");
    await page.getByLabel("Conexão", { exact: true }).first().selectOption({ label: "Financeiro e2e" });
    await page.getByLabel("Número de destino").first().fill("92 99999-0000");
    await page.getByRole("button", { name: "Conferir" }).click();
    await expect(page.getByRole("list", { name: "Lista de verificação do envio" }).getByText(/A conexão está pausada/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar mensagem de teste" })).toBeDisabled();
  });

  await test.step("a rota do QR/estado exige login e a ajuda da tela existe", async () => {
    const anon = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
    const r = await anon.request.get("/api/v1/whatsapp/sessions/00000000-0000-4000-8000-000000000000/state", { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308, 401, 403]).toContain(r.status());
    await anon.close();
    await page.goto("/whatsapp");
    await expect(page.getByRole("link", { name: /Ajuda/ }).first()).toBeVisible();
    await page.goto("/ajuda/whatsapp-conexao");
    await expect(page.getByRole("heading", { name: /WhatsApp: conectar o número/ })).toBeVisible();
  });
});
