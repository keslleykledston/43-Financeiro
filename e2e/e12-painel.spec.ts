import { test, expect } from "@playwright/test";

test("E12 — painel executivo com números reais: indicadores rastreáveis, gráficos acessíveis, alertas, grupo e recebimentos", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();

  await test.step("sem números fictícios; aviso de validação no topo", async () => {
    await expect(page.getByText("números reais")).toBeVisible();
    await expect(page.getByText("exemplo", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Dados fictícios/)).toHaveCount(0);
    await expect(page.getByRole("status").first()).toContainText("VALIDAÇÃO");
  });

  await test.step("indicadores com link para a origem", async () => {
    for (const [label, href] of [["A receber", "/contas-a-receber"], ["Vencido", "/contas-a-receber?status=vencidas"], ["Emitido no mês", "/faturamento/lotes"], ["Saldo pelo extrato", "/conciliacao"]] as const) {
      await expect(page.locator('section[aria-label="Indicadores"]').getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute("href", href);
    }
    await expect(page.locator('section[aria-label="Indicadores"]').getByRole("link", { name: /^Recebido no mês/ })).toHaveAttribute("href", /\/contas-a-receber\/recebimentos\?mes=\d{4}-\d{2}/);
  });

  await test.step("gráficos têm nome acessível e tabela alternativa; previsão avisa que só tem entradas", async () => {
    await expect(page.getByRole("img", { name: "Emitido e recebido por mês" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Entradas projetadas por semana" })).toBeVisible();
    await expect(page.getByText(/Saídas não estão consideradas/)).toBeVisible();
    await expect(page.getByText(/Qualidade:/)).toBeVisible();
    await expect(page.getByRole("table", { name: "Emitido e recebido por mês" })).toHaveCount(1); // sr-only
  });

  await test.step("dados ausentes explicados", async () => {
    await expect(page.getByText("Dados ausentes e limites desta visão")).toBeVisible();
    await expect(page.getByText(/Contas a pagar ainda não existem/)).toBeVisible();
  });

  await test.step("grupo: soma as empresas que o usuário acessa, por empresa", async () => {
    await page.getByRole("link", { name: "Grupo" }).click();
    await expect(page.getByText("Grupo (empresas que você acessa)")).toBeVisible();
    await expect(page.getByText("Por empresa")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "K3G Solutions" }).first()).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "K3G Call" }).first()).toBeVisible();
    await page.screenshot({ path: "e2e-results/shots/desktop-painel-grupo.png", fullPage: true });
  });

  await test.step("drill-down: recebimentos do mês", async () => {
    await page.goto("/");
    await page.locator('section[aria-label="Indicadores"]').getByRole("link", { name: /^Recebido no mês/ }).click();
    await expect(page.getByRole("heading", { name: /^Recebimentos de \d{2}\/\d{4}/ })).toBeVisible();
    await expect(page.getByText(/Estornos aparecem na lista, mas não entram na soma/)).toBeVisible();
  });

  await test.step("tela cheia para captura", async () => {
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.screenshot({ path: "e2e-results/shots/desktop-painel.png", fullPage: true });
  });
});
