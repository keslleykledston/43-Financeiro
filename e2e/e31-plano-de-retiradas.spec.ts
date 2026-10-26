import { test, expect } from "@playwright/test";

const run = Date.now() % 100000;

test("D4 — plano de retiradas: premissas, retirada planejada por sócio, tabela de 12 meses e avisos", async ({ page }) => {
  const socio = `Sócio Plano ${run}`;
  await page.goto("/despesas-cadastros");
  await page.getByLabel("Nome do novo sócio").fill(socio);
  await page.getByRole("button", { name: "Adicionar sócio" }).click();
  await expect(page.getByLabel(`Nome do sócio: ${socio}`)).toBeVisible();

  await page.goto("/socios");
  await page.getByRole("link", { name: "Plano de retiradas e lucro" }).click();
  await expect(page.getByRole("heading", { name: "Plano de retiradas e lucro" })).toBeVisible();
  await expect(page.getByText(/projeção para decidir/)).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect(page.locator("section[aria-label='Resumo']")).toContainText("Retirada sugerida por mês");

  const linha = page.locator("li", { hasText: socio });
  await linha.getByLabel("Planejado por mês (R$)").fill("5.000,00");
  await linha.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Salvo.")).toBeVisible();
  await expect(page.locator("li", { hasText: socio }).getByLabel("Planejado por mês (R$)")).toHaveValue("5000,00");
  await expect(page.getByText(/Informe o caixa atual para ver a projeção/)).toBeVisible(); // aviso presente enquanto o caixa não foi informado

  await page.getByLabel("Inadimplência esperada (%)").fill("4,5");
  await page.getByLabel("Reserva de caixa (meses de despesa)").fill("3");
  await page.getByLabel("Caixa atual (R$, opcional)").fill("10.000,00");
  await page.getByRole("button", { name: "Salvar premissas" }).click();
  await expect(page.getByText("Salvo.")).toBeVisible();
  await expect(page.getByLabel("Inadimplência esperada (%)")).toHaveValue("4,5");
  await expect(page.getByRole("columnheader", { name: "Caixa", exact: true })).toBeVisible(); // com caixa informado aparece a coluna de caixa
  // valor inválido é recusado com mensagem
  await page.getByLabel("Inadimplência esperada (%)").fill("150");
  await page.getByRole("button", { name: "Salvar premissas" }).click();
  await expect(page.getByText(/Inadimplência: informe um percentual de 0 a 100/)).toBeVisible();
});
