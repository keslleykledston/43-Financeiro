import { test, expect } from "@playwright/test";

test("375px: navegação inferior visível e sem rolagem horizontal", async ({ page }) => {
  for (const r of ["/", "/clientes", "/clientes/novo", "/clientes/importar", "/contratos", "/contratos/novo", "/socios", "/despesas-cadastros", "/faturamento", "/faturamento/lotes", "/faturamento/ajustes", "/contratos/importar", "/contratos/alertas", "/empresa", "/historico", "/comissoes", "/faturamento/emissoes", "/mensagens", "/mensagens/modelos", "/mensagens/configuracao", "/conta", "/auditoria", "/ajuda", "/ajuda/importar-contratos", "/contas-a-receber", "/contas-a-pagar", "/contas-a-pagar/novo", "/contas-a-pagar/execucao", "/conciliacao", "/integracoes", "/design-system", "/configuracao"]) {
    await page.goto(r);
    await expect(page.getByRole("navigation", { name: "Principal" }).last()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `overflow horizontal em ${r}`).toBeLessThanOrEqual(0);
  }
});

test.describe("login em 375px", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("sem rolagem horizontal", async ({ page }) => {
    await page.goto("/login");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test("375px: valores dos indicadores do início não são cortados e não há rolagem horizontal", async ({ page }) => {
  await page.goto("/");
  const valores = page.locator('section[aria-label="Indicadores"] .num');
  await expect(valores).toHaveCount(8);
  for (let i = 0; i < 8; i++) {
    const el = valores.nth(i);
    await expect(el).toBeVisible();
    expect(await el.evaluate((n) => n.scrollWidth > n.clientWidth + 1), `indicador ${i} cortado`).toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
