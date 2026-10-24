import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(50000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Planilha ${run}`;
const HEAD = "razao_social;documento;servico;valor_mensal;dia_vencimento;inicio;fim;email_financeiro;contato;parceiro_comissao";

test("E14 — importar contratos: prévia classifica as linhas, lote nasce em rascunho e é aprovado de uma vez", async ({ page }) => {
  await test.step("a tela abre pelo botão Importar em Contratos", async () => {
    await page.goto("/contratos");
    await page.getByRole("link", { name: "Importar" }).click();
    await expect(page.getByRole("heading", { name: "Importar contratos" })).toBeVisible();
    await expect(page.getByText(/nada é gravado até você confirmar/)).toBeVisible();
  });

  await test.step("prévia: uma linha boa (cliente novo + comissão) e uma com CNPJ inválido", async () => {
    const csv = [HEAD, `${NOME};${cnpj(run)};Plano call;798,00;5;2026-01-01;;fin@planilha.example;Maria;Medina`, `Cliente Ruim ${run};11.111.111/1111-11;Plano;100,00;5;2026-01-01;;;;`].join("\n");
    await page.getByLabel("ou cole o conteúdo").fill(csv);
    await page.getByRole("button", { name: /^Revisar/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "com cliente novo" })).toContainText("1 com cliente novo");
    await expect(page.getByText("cliente será criado como cadastro local")).toBeVisible();
    await expect(page.getByText("CNPJ/CPF inválido")).toBeVisible();
    await expect(page.getByText(/comissão Medina/).first()).toBeVisible();
  });

  await test.step("confirmar cria o lote em rascunho", async () => {
    await page.getByRole("button", { name: /^Confirmar: criar 1 contrato/ }).click();
    await expect(page.getByRole("heading", { name: "Lote de importação" })).toBeVisible();
    await expect(page.getByText(NOME)).toBeVisible();
    await expect(page.getByText("Aguardando", { exact: true })).toBeVisible();
    await expect(page.getByText(/comissão Medina/)).toBeVisible();
  });

  await test.step("aprovar o lote ativa o contrato; a marca de comissão aparece no contrato", async () => {
    await page.getByRole("button", { name: /^Aprovar 1 contrato/ }).click();
    await expect(page.getByText("Ativo", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: new RegExp(NOME) }).click();
    await expect(page.getByText("Comissão de parceiro", { exact: true })).toBeVisible();
    await expect(page.getByText("Medina", { exact: true })).toBeVisible();
  });

  await test.step("importar o mesmo arquivo de novo não duplica", async () => {
    await page.goto("/contratos/importar");
    await page.getByLabel("ou cole o conteúdo").fill([HEAD, `${NOME};${cnpj(run)};Plano call;798,00;5;2026-01-01;;;;Medina`].join("\n"));
    await page.getByRole("button", { name: /^Revisar/ }).click();
    await expect(page.getByText("o cliente já tem contrato")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Confirmar/ })).toBeDisabled();
  });
});
