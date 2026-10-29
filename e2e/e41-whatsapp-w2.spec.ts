import { test, expect } from "@playwright/test";

const WAHA = process.env.FAKE_WAHA_URL ?? "http://waha:3000";
const KEY = process.env.FAKE_WAHA_KEY ?? "sandbox-waha-key";
const H = { "X-Api-Key": KEY };

test("W2 — WhatsApp: vincular a K3G Call à mesma conexão, consentimento/opt-out, bloqueios e isolamento entre empresas (WAHA falsa)", async ({ page, request }) => {
  await request.post(`${WAHA}/__test/reset`, { headers: H });

  await test.step("a K3G Solutions cria e conecta uma conexão (um QR só)", async () => {
    await page.goto("/whatsapp");
    await page.getByLabel("Nome interno da conexão").fill("Grupo e2e");
    await page.getByLabel(/Confirmo que tenho autorização/).check();
    await page.getByRole("button", { name: "Conectar WhatsApp" }).click();
    await expect(page.getByText("Conexão criada")).toBeVisible();
    const list = await (await request.get(`${WAHA}/api/sessions`, { headers: H })).json();
    expect(list).toHaveLength(1);
    await request.post(`${WAHA}/__test/connect`, { headers: H, data: { name: list[0].name, phone: "5592988887777" } });
    await page.goto("/whatsapp");
    const card = page.locator("section", { hasText: "Grupo e2e" }).first();
    await expect(card.getByTestId("wa-live-status")).toHaveText("Conectada", { timeout: 25_000 });
  });

  await test.step("vincular a K3G Call exige a confirmação das duas diretorias; depois a conexão lista as duas empresas", async () => {
    await page.goto("/whatsapp");
    const card = page.locator("section", { hasText: "Grupo e2e" }).first();
    await expect(card.getByText("Empresas que usam esta conexão")).toBeVisible();
    await card.getByLabel("Vincular outra empresa").selectOption({ label: "K3G Call" });
    await card.getByLabel("Como o cliente vê quem escreve", { exact: true }).fill("Financeiro K3G Call");
    await card.getByRole("button", { name: "Vincular empresa" }).click(); // sem confirmar: o navegador barra (required)
    await expect(page.getByText("Empresa vinculada à conexão")).toHaveCount(0);
    await card.getByLabel(/Confirmo que a diretoria das/).check();
    await card.getByRole("button", { name: "Vincular empresa" }).click();
    await expect(page.getByText("Empresa vinculada à conexão")).toBeVisible();
    const after = page.locator("section", { hasText: "Grupo e2e" }).first();
    await expect(after.getByText("K3G Call", { exact: true })).toBeVisible();
    await expect(after.getByText("«Financeiro K3G Call»")).toBeVisible();
    await expect(after.getByRole("button", { name: /Tirar .* desta conexão/ })).toBeVisible();
  });

  await test.step("a K3G Call enxerga a MESMA conexão, com o seu próprio remetente, e nenhuma autorização da outra empresa", async () => {
    await page.goto("/");
    await page.getByLabel("Empresa").selectOption({ label: "K3G Call" });
    await page.getByRole("button", { name: "Trocar" }).click();
    await expect(page.getByText("K3G Call · ")).toBeVisible();
    await page.goto("/whatsapp");
    await expect(page.getByText("K3G Call · conexões")).toBeVisible();
    const card = page.locator("section", { hasText: "Grupo e2e" }).first();
    await expect(card.getByText("+55 92 •••••-7777")).toBeVisible();
    await expect(card.getByText("«Financeiro K3G Call»")).toBeVisible();
    await page.goto("/whatsapp/teste");
    await expect(page.getByText("Não registrada")).toBeVisible();       // a autorização é por empresa
    await page.goto("/whatsapp/consentimentos");
    await expect(page.getByText("Nenhum registro ainda.")).toBeVisible(); // consentimentos também
  });

  await test.step("consentimento: registrar, ver mascarado; recusa repetido; opt-out aparece e prevalece", async () => {
    await page.goto("/whatsapp/consentimentos");
    await expect(page.getByRole("heading", { name: "Consentimentos de WhatsApp" })).toBeVisible();
    await page.getByLabel("Número do contato").fill("92 99999-0000");
    await page.getByLabel("O que o contato decidiu").selectOption("opt_in");
    await page.getByLabel("De onde vem a prova").selectOption("escrito");
    await page.getByLabel("Onde está a prova").fill("e-mail de 28/10/2026");
    await page.getByRole("button", { name: "Registrar" }).click();
    await expect(page.getByText("Registrado. O pedido de parar vale na hora")).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.getByText("+55 92 •••••-0000")).toBeVisible();
    await expect(table.getByText("Consentiu", { exact: true })).toBeVisible();
    // repetir o mesmo estado é recusado
    await page.getByLabel("Número do contato").fill("(92) 99999-0000");
    await page.getByLabel("O que o contato decidiu").selectOption("opt_in");
    await page.getByLabel("De onde vem a prova").selectOption("escrito");
    await page.getByLabel("Onde está a prova").fill("e-mail de 28/10/2026");
    await page.getByRole("button", { name: "Registrar" }).click();
    await expect(page.getByText(/já está registrado assim/)).toBeVisible();
    // pediu para parar: vira o estado atual
    await page.getByLabel("Número do contato").fill("92 99999-0000");
    await page.getByLabel("O que o contato decidiu").selectOption("opt_out");
    await page.getByLabel("De onde vem a prova").selectOption("verbal");
    await page.getByLabel("Onde está a prova").fill("pedido por telefone em 29/10");
    await page.getByRole("button", { name: "Registrar" }).click();
    await expect(page.getByRole("table").getByText("Pediu para parar (esta empresa)")).toBeVisible();
  });

  await test.step("o pedido de parar bloqueia o teste mesmo com o número autorizado, e o motivo aparece em «Envios bloqueados»", async () => {
    await page.goto("/whatsapp/teste");
    await page.getByLabel("Referência da autorização escrita").fill("e-mail da diretoria de 29/10/2026");
    await page.getByLabel(/Números que podem receber/).fill("92 99999-0000");
    await page.getByRole("button", { name: "Registrar autorização" }).click();
    await expect(page.getByText("Autorização registrada. Nada foi enviado")).toBeVisible();
    await page.getByLabel("Conexão", { exact: true }).first().selectOption({ label: "Grupo e2e" });
    await page.getByLabel("Número de destino").first().fill("92 99999-0000");
    await page.getByRole("button", { name: "Conferir" }).click();
    const list = page.getByRole("list", { name: "Lista de verificação do envio" });
    await expect(list.getByText("Este número pediu para não receber mensagens desta empresa")).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar mensagem de teste" })).toBeDisabled();
    await expect(page.getByText("Nenhum envio bloqueado ainda.")).toBeVisible(); // «Conferir» não envia nem registra bloqueio
    const sent = await (await request.get(`${WAHA}/__test/sent`, { headers: H })).json();
    expect(sent).toHaveLength(0);
  });

  await test.step("a K3G Call sai da conexão: some para ela e a K3G Solutions segue usando", async () => {
    await page.goto("/whatsapp");
    const card = page.locator("section", { hasText: "Grupo e2e" }).first();
    const sair = card.locator("form", { has: page.getByRole("button", { name: /Tirar .* desta conexão/ }) }); // o «Confirmo» DESTE formulário (há outro, o de desconectar)
    await sair.getByLabel("Confirmo").check();
    await sair.getByRole("button", { name: /Tirar .* desta conexão/ }).click();
    await expect(page.getByText("Esta empresa deixou de usar a conexão")).toBeVisible();
    await expect(page.getByText("Grupo e2e")).toHaveCount(0);
    await page.goto("/");
    await page.getByLabel("Empresa").selectOption({ label: "K3G Solutions" });
    await page.getByRole("button", { name: "Trocar" }).click();
    await expect(page.getByText("K3G Solutions · ")).toBeVisible();
    await page.goto("/whatsapp");
    await expect(page.locator("section", { hasText: "Grupo e2e" }).first().getByText("K3G Solutions", { exact: true })).toBeVisible();
  });

  await test.step("ajuda das duas telas existe", async () => {
    await page.goto("/ajuda/whatsapp-consentimentos");
    await expect(page.getByRole("heading", { name: /WhatsApp: consentimento e pedido de parar/ })).toBeVisible();
  });
});
