import { test } from "@playwright/test";

// Capturas para revisão visual humana (não afirmam nada). Saem em e2e-results/shots/.
const anon = { cookies: [], origins: [] };

test.describe("capturas desktop", () => {
  test("login", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: anon, viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage(); await p.goto("/login");
    await p.screenshot({ path: "e2e-results/shots/desktop-login.png" });
    await ctx.close();
  });
  for (const [name, path] of [["inicio", "/"], ["clientes", "/clientes"], ["integracoes", "/integracoes"], ["design", "/design-system"], ["ajustes", "/configuracao"]] as const) {
    test(`${name} claro e escuro`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      await page.screenshot({ path: `e2e-results/shots/desktop-${name}-claro.png`, fullPage: name === "design" });
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.screenshot({ path: `e2e-results/shots/desktop-${name}-escuro.png`, fullPage: name === "design" });
    });
  }
});
