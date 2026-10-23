import { test, expect } from "@playwright/test";

test("375px: menu 'Mais' abre o menu completo, navega e fecha; design-system sem rolagem horizontal", async ({ page }) => {
  await page.goto("/");
  const menu = page.getByRole("dialog", { name: "Menu completo" });
  // a página pode hidratar depois do primeiro clique: repete até o menu abrir
  await expect(async () => { await page.getByRole("button", { name: "Mais" }).click(); await expect(menu).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 15_000 });
  await expect(menu.getByRole("link", { name: /Conciliação/ })).toBeVisible();
  await menu.getByRole("link", { name: /Conciliação/ }).click();
  await expect(page).toHaveURL(/\/conciliacao/);
  await expect(menu).toBeHidden();
  await page.goto("/design-system");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
