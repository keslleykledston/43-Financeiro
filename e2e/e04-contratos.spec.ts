import { test, expect, type Page } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(80000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Contrato ${run}`;

async function novoContrato(page: Page, o: { dia: string; servico: string; valor?: string; nf?: boolean }) {
  await page.goto("/contratos/novo");
  await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
  await page.getByLabel("Serviço contratado").fill(o.servico);
  await page.getByLabel("Valor mensal (R$)").fill(o.valor ?? "2.500,00");
  await page.getByLabel("Dia de vencimento (1–31)").fill(o.dia);
  await page.getByLabel("Início da vigência").fill("2026-01-01");
  if (o.nf) await page.getByLabel(/exige NF emitida junto/).check();
  await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
}
const aprovar = async (page: Page) => { await page.getByRole("button", { name: "Aprovar" }).click(); await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible(); };

test("E04 — contrato: criar → aprovar → calendário; alteração com aprovação; cliente suspenso; dia 31 e feriado em revisão", async ({ page }) => {
  await test.step("cria o cliente de teste", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  });
  const clienteUrl = page.url();

  await test.step("estado vazio útil e validações do formulário", async () => {
    await page.goto("/contratos");
    await expect(page.getByText("Nenhum contrato ainda")).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Teste");
    await page.getByLabel("Valor mensal (R$)").fill("2500.50");
    await page.getByLabel("Dia de vencimento (1–31)").fill("5");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await expect(page.locator("p[role=alert]")).toContainText("Valor mensal inválido");
    await expect(page.getByLabel("Serviço contratado")).toHaveValue("Teste"); // não perde o que digitou
  });

  await test.step("contrato nasce rascunho, não aparece no calendário, e passa a valer após aprovar", async () => {
    await novoContrato(page, { dia: "5", servico: "Monitoramento NOC" });
    await expect(page.getByText("Rascunho (aguardando aprovação)")).toBeVisible();
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByText("Nenhum evento neste mês")).toBeVisible();             // rascunho não fatura
    await page.goto("/contratos"); await page.getByRole("link", { name: new RegExp(NOME) }).click();
    await aprovar(page);
  });

  await test.step("calendário de outubro/2026: emite dia 25 (domingo, só aviso) e vence dia 5", async () => {
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByRole("heading", { name: /outubro de 2026/i })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^25 de outubro.*1 emissões/ })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^5 de outubro.*1 vencimentos/ })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^12 de outubro.*feriado: Nossa Senhora Aparecida/ })).toBeVisible();
    await expect(page.getByText("Dia 25", { exact: false }).first()).toBeVisible();      // resumo por lote
    await expect(page.getByText(/lote 25 · vence 05\/11\/2026/)).toBeVisible();
    await expect(page.getByText("emissão em fim de semana")).toBeVisible();
    await expect(page.getByText("Precisa de revisão humana")).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.screenshot({ path: "e2e-results/shots/desktop-faturamento-claro.png", fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(400);
    await page.screenshot({ path: "e2e-results/shots/desktop-faturamento-escuro.png", fullPage: true });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.getByRole("link", { name: /novembro/ }).click();                          // navegação de mês
    await expect(page.getByRole("heading", { name: /novembro de 2026/i })).toBeVisible();
  });

  await test.step("alteração: nada vale até aprovar; depois o calendário muda", async () => {
    await page.goto("/contratos"); await page.getByRole("link", { name: new RegExp(NOME) }).click();
    await page.getByLabel("Dia de vencimento (1–31)").fill("10");
    await page.getByLabel("Motivo da alteração").fill("Reajuste combinado");
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText("Alteração enviada para aprovação")).toBeVisible();
    await expect(page.getByText("dia 5 (competência M, vence em M+1)")).toBeVisible();   // termos vigentes intactos
    await expect(page.getByText("Alteração aguardando aprovação")).toBeVisible();
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByRole("gridcell", { name: /^5 de outubro.*1 vencimentos/ })).toBeVisible(); // calendário ainda no dia 5
    await page.goto("/contratos"); await page.getByRole("link", { name: new RegExp(NOME) }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("dia 10 (competência M, vence em M+1)")).toBeVisible();
    await expect(page.getByText("v2")).toBeVisible();
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByRole("gridcell", { name: /^10 de outubro.*1 vencimentos/ })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^5 de outubro.*vencimentos/ })).toHaveCount(0);
  });

  await test.step("dia 31 exige revisão e não vira data", async () => {
    await novoContrato(page, { dia: "31", servico: "Suporte dia 31", valor: "100,00" });
    await aprovar(page);
    await page.goto("/faturamento?mes=2026-10");
    const rev = page.getByRole("region", { name: "Precisa de revisão" });
    await expect(rev).toContainText("Suporte dia 31");
    await expect(rev).toContainText("dia 31 não possui lote confirmado");
  });

  await test.step("feriado da empresa em dia útil marca a emissão para revisão", async () => {
    await page.goto("/faturamento?mes=2026-11");
    await expect(page.getByRole("gridcell", { name: /^25 de novembro.*1 emissões/ })).toBeVisible();      // dia 10 (13–16 não; 10 ≤ 12 → lote 25 de novembro p/ vencer em dezembro)
    await page.getByLabel("Data", { exact: true }).fill("2026-11-25");
    await page.getByLabel("Nome", { exact: true }).fill("Feriado teste da empresa");
    await page.getByRole("button", { name: "Adicionar feriado" }).click();
    await expect(page.getByText("25/11/2026 — Feriado teste da empresa")).toBeVisible();
    await expect(page.getByRole("region", { name: "Precisa de revisão" })).toContainText("feriado; política pendente");
    await page.getByRole("button", { name: "Remover" }).click();
    await expect(page.getByText("Feriado teste da empresa")).toHaveCount(0);
  });

  await test.step("cliente suspenso não fatura; ao reativar volta", async () => {
    await page.goto(clienteUrl);
    await page.getByLabel("Situação").selectOption("suspenso");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Alterações salvas.")).toBeVisible();
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByText("Nenhum evento neste mês")).toBeVisible();
    await page.goto("/contratos"); await page.getByRole("link", { name: new RegExp(NOME) }).first().click();
    await expect(page.getByText(/não gera cobrança enquanto o cliente não voltar a ser ativo/)).toBeVisible();
    await page.goto(clienteUrl);
    await page.getByLabel("Situação").selectOption("ativo");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Alterações salvas.")).toBeVisible();
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByRole("gridcell", { name: /^10 de outubro.*vencimentos/ })).toBeVisible();
  });

  await test.step("suspender o contrato tira do calendário", async () => {
    await page.goto("/contratos"); await page.getByRole("link", { name: /Monitoramento NOC/ }).click();
    await page.getByRole("button", { name: "Suspender" }).click();
    await expect(page.getByText("Suspenso", { exact: true }).first()).toBeVisible();
    await page.goto("/faturamento?mes=2026-10");
    await expect(page.getByRole("gridcell", { name: /^10 de outubro.*vencimentos/ })).toHaveCount(0);
  });
});
