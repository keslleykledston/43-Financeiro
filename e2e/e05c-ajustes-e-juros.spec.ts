import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(40000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Excedente ${run}`;

test("E05c/E07c — excedente lançado à mão entra no valor da cobrança; baixa com juros/multa quita pelo principal", async ({ page }) => {
  await test.step("cliente + contrato de R$ 1.000,00 (vence dia 14 → emissão 01/10/2026)", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Plano call center");
    await page.getByLabel("Valor mensal (R$)").fill("1.000,00");
    await page.getByLabel("Dia de vencimento (1–31)").fill("14");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
  });

  await test.step("lançar o excedente da competência 09/2026 (calculado em outro sistema)", async () => {
    await page.goto("/faturamento/ajustes?mes=2026-09");
    await expect(page.getByRole("heading", { name: "Ajustes da competência" })).toBeVisible();
    await expect(page.getByText(/calculado em outro sistema e lançado aqui/)).toBeVisible();
    const linha = page.locator("li", { hasText: NOME }).first();
    await linha.getByLabel("Descrição").fill("Excedente de minutos");
    await linha.getByLabel("Valor (R$)").fill("412,64");
    await linha.getByRole("button", { name: "Lançar ajuste" }).click();
    await expect(page.getByText(/Ajuste lançado/)).toBeVisible();
    const depois = page.locator("li", { hasText: NOME }).first();
    await expect(depois.getByText("Excedente de minutos")).toBeVisible();
    await expect(depois.getByText(/R\$\s*1\.412,64/).first()).toBeVisible(); // cobrança = contrato + excedente
    await expect(page.getByText("Valor inválido")).toHaveCount(0);
  });

  await test.step("valor inválido e ajuste que zeraria a cobrança são recusados", async () => {
    const linha = page.locator("li", { hasText: NOME }).first();
    await linha.getByLabel("Tipo").selectOption("desconto");
    await linha.getByLabel("Descrição").fill("Desconto absurdo");
    await linha.getByLabel("Valor (R$)").fill("5.000,00");
    await linha.getByRole("button", { name: "Lançar ajuste" }).click();
    await expect(page.getByText(/continuar maior que zero/)).toBeVisible();
  });

  await test.step("lote de 01/10: reabrir, atualizar a prévia, ver a composição e aprovar", async () => {
    await page.goto("/faturamento/lotes?mes=2026-10");
    await page.getByRole("link", { name: /Emissão 01\/10\/2026/ }).click();
    await page.getByLabel("Motivo para reabrir").fill("incluir novo contrato e o excedente");
    await page.getByRole("button", { name: "Reabrir para revalidar" }).click();
    await expect(page.getByText(/Lote reaberto/)).toBeVisible();
    await page.getByRole("button", { name: "Atualizar prévia" }).click();
    const linha = page.locator("li", { hasText: NOME });
    await expect(linha.getByText(/Contrato\s*R\$\s*1\.000,00 \+ Excedente de minutos R\$\s*412,64/)).toBeVisible();
    await expect(linha.getByText(/R\$\s*1\.412,64/).last()).toBeVisible();
    await page.getByRole("button", { name: "Aprovar lote" }).click();
    await expect(page.getByText(/Lote aprovado\. Nada foi emitido/)).toBeVisible();
    await page.screenshot({ path: "e2e-results/shots/desktop-lote-com-excedente.png", fullPage: true });
  });

  await test.step("depois de aprovado, o ajuste fica travado", async () => {
    await page.goto("/faturamento/ajustes?mes=2026-09");
    const linha = page.locator("li", { hasText: NOME }).first();
    await expect(linha.getByText("Lote aprovado")).toBeVisible();
    await expect(linha.getByRole("button", { name: "Lançar ajuste" })).toHaveCount(0);
    await expect(linha.getByRole("button", { name: "Remover" })).toHaveCount(0);
  });

  await test.step("baixa com juros/multa: recebeu R$ 1.442,64 (30,00 de juros) e quitou o principal de R$ 1.412,64", async () => {
    await page.goto(`/contas-a-receber?status=abertas&q=${encodeURIComponent(`Excedente ${run}`)}`);
    await page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.getByLabel("Valor recebido (R$)").fill("1.442,64");
    await page.getByLabel(/Juros\/multa incluídos/).fill("30,00");
    await page.getByRole("button", { name: "Registrar pagamento" }).click();
    await expect(page.getByText(/Cobrança quitada/)).toBeVisible();
    await expect(page.getByText("Quitada", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/inclui juros\/multa de R\$\s*30,00/)).toBeVisible();
    await expect(page.getByText(/Recebimento de R\$\s*1\.442,64/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar pagamento" })).toHaveCount(0);
    await page.screenshot({ path: "e2e-results/shots/desktop-baixa-com-juros.png", fullPage: true });
  });
});
