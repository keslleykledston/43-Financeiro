import { test as setup, expect } from "@playwright/test";
import { ADMIN_STATE } from "../playwright.config";

// Um único login do admin; as demais specs reutilizam a sessão (evita estourar o rate limit).
setup("login do admin sandbox", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(process.env.SANDBOX_ADMIN_EMAIL!);
  await page.getByLabel("Senha").fill(process.env.SANDBOX_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await page.context().storageState({ path: ADMIN_STATE });
});
