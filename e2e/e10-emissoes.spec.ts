import { test, expect } from "@playwright/test";
import { aceitarConvite } from "./helpers";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(60000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Emissao ${run}`;

test("E10 — motor de emissão SIMULADO: nasce pausado, solicita, processa uma vez, trava reabertura, checklist do portão", async ({ page, browser }) => {
  await test.step("cliente + contrato (vence dia 12 → emite 25/09/2026) + lote aprovado", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Link IP");
    await page.getByLabel("Valor mensal (R$)").fill("800,00");
    await page.getByLabel("Dia de vencimento (1–31)").fill("12");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
    await page.goto("/faturamento/lotes?mes=2026-09");
    await page.locator("li", { hasText: /^25\/09\/2026/ }).getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
    await page.getByRole("button", { name: "Aprovar lote" }).click();
    await expect(page.getByText(/Lote aprovado\. Nada foi emitido/)).toBeVisible();
  });

  await test.step("solicitar boletos no lote (apenas enfileira)", async () => {
    await expect(page.getByText(/motor <strong>simulado<\/strong>|motor simulado/)).toBeVisible();
    await page.getByRole("button", { name: "Solicitar boletos" }).click();
    await expect(page.getByRole("heading", { name: "Emissões" })).toBeVisible();
    await expect(page.getByText(/solicitação\(ões\) criada\(s\)/)).toBeVisible();
    await expect(page.getByText(/nenhum boleto ou nota real é emitido/)).toBeVisible();
    await expect(page.getByText(NOME)).toBeVisible();
    await expect(page.getByText("Aguardando").first()).toBeVisible();
  });

  await test.step("pausado por padrão: processar não faz nada", async () => {
    await expect(page.getByText("Emissão pausada").first()).toBeVisible();
    await page.getByRole("button", { name: "Processar agora (simulado)" }).click();
    await expect(page.getByText(/Aviso: Emissão pausada/)).toBeVisible();
    await expect(page.getByText("Aguardando").first()).toBeVisible();
  });

  await test.step("liberar (diretoria) e processar: emite uma vez; reprocessar não repete", async () => {
    await page.getByLabel(/Pausar emissão/).uncheck();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();
    await expect(page.getByText("Emissão liberada (simulada)")).toBeVisible();
    await page.getByRole("button", { name: "Processar agora (simulado)" }).click();
    await expect(page.getByText(/Rodada simulada: [1-9]\d* emitido/)).toBeVisible();
    await expect(page.getByText("Emitido (simulado)").first()).toBeVisible();
    await expect(page.getByText(/ref\. mock-boleto-/).first()).toBeVisible();
    await page.getByRole("button", { name: "Processar agora (simulado)" }).click();
    await expect(page.getByText(/Rodada simulada: 0 emitido/)).toBeVisible();
    await page.screenshot({ path: "e2e-results/shots/desktop-emissoes.png", fullPage: true });
  });

  await test.step("lote com emissão concluída não pode ser reaberto", async () => {
    await page.goto("/faturamento/lotes?mes=2026-09");
    await page.getByRole("link", { name: /Emissão 25\/09\/2026/ }).click();
    await page.getByLabel("Motivo para reabrir").fill("tentar reabrir depois de emitir");
    await page.getByRole("button", { name: "Reabrir para revalidar" }).click();
    await expect(page.getByText(/emissões em andamento ou concluídas/)).toBeVisible();
  });

  await test.step("E30 — gerente PEDE o cancelamento; a diretoria recusa com motivo e o boleto continua valendo", async () => {
    const email = `gerente-pedido-${Date.now()}@sandbox.test`;
    await page.goto("/configuracao?aba=usuarios");
    await page.getByLabel("E-mail").fill(email);
    await page.getByLabel("Papel").selectOption({ label: "Gerente" });
    await page.getByRole("button", { name: "Convidar" }).click();
    const link = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
    const path = new URL((await link.innerText()).trim()).pathname;
    const guest = await aceitarConvite(browser, path, "Gerente Pedido", "Gerente-Pedido-Senha-321");
    const g = guest.page;
    await g.goto("/contas-a-receber");
    await g.locator('a[href^="/contas-a-receber/"]', { hasText: NOME }).first().click();
    await expect(g.getByText("Cancelar boleto (só a diretoria)")).toHaveCount(0); // gerente não cancela
    await g.getByText("Pedir o cancelamento deste boleto").click();
    await g.getByLabel(/Motivo do pedido/).fill("cliente pediu novo vencimento");
    await g.getByRole("button", { name: "Enviar pedido" }).click();
    await expect(g.getByText(/Pedido de cancelamento enviado para a diretoria/)).toBeVisible();
    await expect(g.getByText("Pedido de cancelamento aguardando a diretoria")).toBeVisible();
    await expect(g.getByRole("button", { name: "Retirar meu pedido" })).toBeVisible();
    await guest.ctx.close();
    // diretoria
    await page.goto("/");
    await expect(page.getByText(/pedido de cancelamento de boleto aguardando decisão/)).toBeVisible();
    await page.goto("/contas-a-receber");
    await page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME }).first().click();
    await expect(page.getByText("Pedido de cancelamento aguardando a diretoria")).toBeVisible();
    await expect(page.getByText("Motivo: cliente pediu novo vencimento")).toBeVisible();
    await page.getByLabel("Motivo da recusa").fill("ainda vale a emissão atual");
    await page.getByRole("button", { name: "Recusar pedido" }).click();
    await expect(page.getByText(/Pedido de cancelamento recusado/)).toBeVisible();
    await expect(page.getByText(/Situação da emissão: Emitido/)).toBeVisible();
    await expect(page.getByLabel("Pedidos de cancelamento anteriores")).toContainText("Recusado");
  });

  await test.step("E20 — cancelar o boleto (diretoria): motivo e confirmação obrigatórios, fica registrado", async () => {
    await page.goto("/contas-a-receber");
    await page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME }).first().click();
    await expect(page.getByRole("heading", { name: "Boleto", exact: true })).toBeVisible();
    await expect(page.getByText(/Situação da emissão: Emitido/)).toBeVisible();
    await page.getByText("Cancelar boleto (só a diretoria)").click();
    await page.getByLabel(/Motivo \(3 a 200/).fill("valor errado na cobrança");
    await page.getByRole("button", { name: "Cancelar boleto", exact: true }).click();      // sem marcar a confirmação: o navegador barra
    await expect(page.getByText(/Boleto cancelado e registrado/)).toHaveCount(0);
    await page.getByLabel(/Confirmo o cancelamento/).check();
    await page.getByRole("button", { name: "Cancelar boleto", exact: true }).click();
    await expect(page.getByText(/Boleto cancelado e registrado/)).toBeVisible();
    await expect(page.getByText("Motivo: valor errado na cobrança")).toBeVisible();
    await expect(page.getByText("Cancelado", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Sem boleto ativo/)).toBeVisible();
    await expect(page.getByText("Cancelar boleto (só a diretoria)")).toHaveCount(0);        // não cancela duas vezes
    await page.goto("/auditoria");
    await expect(page.getByText("boleto.cancelled").first()).toBeVisible();
  });

  await test.step("checklist do portão da emissão real: tudo pendente, chaves desligadas", async () => {
    await page.goto("/integracoes");
    await expect(page.getByRole("heading", { name: "Portão da emissão real (checklist)" })).toBeVisible();
    await expect(page.getByText("Autorização explícita da diretoria")).toBeVisible();
    await expect(page.getByText("Chaves de emissão/envio reais desligadas")).toBeVisible();
    await expect(page.getByText("Pendente", { exact: true }).first()).toBeVisible();
  });

  await test.step("deixa o ambiente pausado de novo", async () => {
    await page.goto("/faturamento/emissoes");
    await page.getByLabel(/Pausar emissão/).check();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Emissão pausada").first()).toBeVisible();
  });
});
