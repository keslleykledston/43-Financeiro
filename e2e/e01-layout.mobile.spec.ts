import { test, expect } from "@playwright/test";

test("375px: navegação inferior visível e sem rolagem horizontal", async ({ page }) => {
  for (const r of ["/", "/clientes", "/clientes/novo", "/clientes/importar", "/contratos", "/contratos/novo", "/faturamento", "/faturamento/lotes", "/faturamento/emissoes", "/mensagens", "/mensagens/modelos", "/mensagens/configuracao", "/conta", "/contas-a-receber", "/conciliacao", "/integracoes", "/design-system", "/configuracao"]) {
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

test("375px: valores dos cartões do início não são cortados", async ({ page }) => {
  await page.goto("/");
  for (const v of ["R$ 184.320,00", "R$ 131.870,00", "R$ 52.450,00", "R$ 9.210,00"]) {
    const el = page.getByText(v, { exact: true });
    await expect(el).toBeVisible();
    const clipped = await el.evaluate((n) => n.scrollWidth > n.clientWidth + 1);
    expect(clipped, `${v} cortado`).toBe(false);
  }
});
