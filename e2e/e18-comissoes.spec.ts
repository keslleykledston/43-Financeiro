import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Comissao ${run}`;

test("E18 — comissão: marcar parceiro e percentual no contrato; tela de comissões do mês", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();

  await page.goto("/contratos/novo");
  await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
  await page.getByLabel("Serviço contratado").fill("Link dedicado");
  await page.getByLabel("Valor mensal (R$)").fill("2.500,00");
  await page.getByLabel("Dia de vencimento (1–31)").fill("10");
  await page.getByLabel("Início da vigência").fill("2026-01-01");
  await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();

  await test.step("percentual inválido é recusado; válido salva", async () => {
    await page.getByLabel("Parceiro (vazio = sem comissão)").fill("Medina");
    await page.getByLabel("Percentual (%)").fill("150");
    await page.getByRole("button", { name: "Salvar comissão" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Percentual inválido" })).toBeVisible();
    await page.getByLabel("Parceiro (vazio = sem comissão)").fill("Medina");
    await page.getByLabel("Percentual (%)").fill("30");
    await page.getByRole("button", { name: "Salvar comissão" }).click();
    await expect(page.getByText("Comissão atualizada")).toBeVisible();
    await expect(page.getByText("percentual 30% sobre o valor mensal")).toBeVisible();
  });

  await test.step("tela de comissões lista o parceiro e o mês", async () => {
    await page.goto("/comissoes");
    await expect(page.getByRole("heading", { name: "Comissões" })).toBeVisible();
    await expect(page.getByLabel("Parceiro")).toHaveValue("Medina");
    await expect(page.getByText("Nada recebido neste mês")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Histórico de fechamentos" })).toBeVisible();
    await page.getByRole("link", { name: "Ajuda desta tela" }).click();
    await expect(page).toHaveURL(/\/ajuda\/comissoes$/);
  });
});
