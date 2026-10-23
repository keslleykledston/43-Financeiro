import { test, expect } from "@playwright/test";

test("375px: navegação inferior visível e sem rolagem horizontal", async ({ page }) => {
  for (const r of ["/", "/clientes", "/clientes/novo", "/clientes/importar", "/integracoes", "/configuracao"]) {
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
