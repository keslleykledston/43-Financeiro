import { test } from "@playwright/test";

test("capturas 375px", async ({ page, browser }) => {
  await page.goto("/"); await page.screenshot({ path: "e2e-results/shots/mobile-inicio-claro.png" });
  await page.getByRole("button", { name: "Mais" }).click();
  await page.screenshot({ path: "e2e-results/shots/mobile-menu.png" });
  await page.keyboard.press("Escape");
  await page.goto("/clientes"); await page.screenshot({ path: "e2e-results/shots/mobile-clientes-claro.png" });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({ path: "e2e-results/shots/mobile-clientes-escuro.png" });
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 375, height: 812 } });
  const l = await ctx.newPage(); await l.goto("/login"); await l.screenshot({ path: "e2e-results/shots/mobile-login.png" }); await ctx.close();
});
