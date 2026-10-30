import { test, expect } from "@playwright/test";

test("W1 375px: Conexões e Enviar teste sem rolagem horizontal e com os controles principais visíveis", async ({ page }) => {
  for (const path of ["/whatsapp", "/whatsapp/teste", "/whatsapp/consentimentos", "/whatsapp/configuracao", "/whatsapp/historico", "/whatsapp/enviar", "/whatsapp/entrada", "/whatsapp/regua"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} rola na horizontal`).toBeLessThanOrEqual(0);
  }
  await page.goto("/whatsapp");
  await expect(page.getByText("não é um canal oficial")).toBeVisible();
});
