import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Auto ${run}`;

test("F1 — faturamento automático: liga em Autorizações; o lote ganha «Aprovar e agendar emissão» e mostra o andamento; desliga e volta ao manual", async ({ page }) => {
  await test.step("cliente + contrato (vence dia 20 → emissão 08/12/2026)", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Link IP");
    await page.getByLabel("Valor mensal (R$)").fill("800,00");
    await page.getByLabel("Dia de vencimento (1–31)").fill("20");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
  });

  await test.step("desligado: o lote só tem a aprovação manual", async () => {
    await page.goto("/faturamento/lotes?mes=2026-12");
    await page.locator("li", { hasText: /^08\/12\/2026/ }).getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
    await expect(page.getByRole("button", { name: "Aprovar lote" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Aprovar e agendar/ })).toHaveCount(0);
  });

  await test.step("liga o faturamento automático (1 clique, fica registrado)", async () => {
    await page.goto("/autorizacoes");
    await page.getByRole("switch", { name: /Faturamento automático: ligar/ }).click();
    await expect(page.getByText(/Faturamento automático LIGADO/)).toBeVisible();
    await expect(page.getByRole("switch", { name: /Faturamento automático: desligar/ })).toHaveAttribute("aria-checked", "true");
  });

  await test.step("«Aprovar e agendar emissão» explica o que vai acontecer e agenda", async () => {
    await page.goto("/faturamento/lotes?mes=2026-12");
    await page.locator("li", { hasText: /^08\/12\/2026/ }).getByRole("link").first().click();
    await expect(page.getByText(/«Aprovar e agendar» emite os/)).toBeVisible();
    await expect(page.getByText(/às 09:00/).first()).toBeVisible();
    await page.getByRole("button", { name: "Aprovar e agendar emissão" }).click();
    await expect(page.getByText(/emissão AGENDADA/)).toBeVisible();
    const card = page.locator("section", { has: page.getByRole("heading", { name: "Emissão agendada" }) });
    await expect(card).toBeVisible();
    await expect(card.getByText(/Prévia aprovada/)).toBeVisible();
    await expect(card.getByText(/emitido\(s\)/)).toBeVisible();
    await expect(card.getByText(/Fila de e-mails/)).toBeVisible();
    await expect(page.getByText(/Conferência de pagamentos na Cora/)).toBeVisible();
  });

  await test.step("desliga: tudo volta ao modo manual", async () => {
    await page.goto("/autorizacoes");
    await page.getByRole("switch", { name: /Faturamento automático: desligar/ }).click();
    await expect(page.getByText(/Faturamento automático DESLIGADO/)).toBeVisible();
  });
});
