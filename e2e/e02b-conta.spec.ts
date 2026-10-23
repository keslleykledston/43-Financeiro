import { test, expect, type Browser } from "@playwright/test";

const ANTIGA = "Convidado-Senha-456", NOVA = "Senha-Trocada-789-xyz";

async function entrar(browser: Browser, email: string, senha: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar" }).click();
  return { ctx, page };
}

// Usa um usuário convidado (nunca o admin compartilhado do auth.setup, para não invalidar os outros specs).
test("Minha conta — trocar a própria senha ponta a ponta", async ({ page, browser }) => {
  const email = `conta-${Date.now()}@sandbox.test`;
  await page.goto("/configuracao");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: "Assistente" });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  const path = new URL((await code.innerText()).trim()).pathname;

  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const g = await guest.newPage();
  await g.goto(path);
  await g.getByLabel("E-mail convidado").fill(email);
  await g.getByLabel("Nome").fill("Usuária Conta");
  await g.getByLabel(/^Senha/).fill(ANTIGA);
  await g.getByRole("button", { name: "Criar acesso" }).click();
  await expect(g).toHaveURL(/\/login/);
  await guest.close();

  const { ctx, page: u } = await entrar(browser, email, ANTIGA);
  await expect(u.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  // menu do usuário → Minha conta
  await u.getByRole("button", { name: /Menu do usuário/ }).or(u.locator("summary[aria-label^='Menu do usuário']")).click();
  await u.getByRole("link", { name: "Minha conta" }).click();
  await expect(u.getByRole("heading", { name: "Minha conta" })).toBeVisible();

  const enviar = async (atual: string, nova: string, conf: string) => {
    await u.getByLabel("Senha atual").fill(atual);
    await u.getByLabel("Nova senha", { exact: true }).fill(nova);
    await u.getByLabel("Confirmar nova senha").fill(conf);
    await u.getByRole("button", { name: "Alterar senha" }).click();
  };
  await enviar("senha-errada-12345", NOVA, NOVA);
  await expect(u.locator("p[role=alert]")).toContainText("Senha atual incorreta");
  await enviar(ANTIGA, NOVA, NOVA + "x");
  await expect(u.locator("p[role=alert]")).toContainText("confirmação não confere");
  await enviar(ANTIGA, NOVA, NOVA);
  await expect(u.getByText("Senha alterada")).toBeVisible();
  await ctx.close();

  // senha antiga deixa de valer; a nova entra
  const velha = await entrar(browser, email, ANTIGA);
  await expect(velha.page.locator("p[role=alert]")).toBeVisible();
  await velha.ctx.close();
  const nova = await entrar(browser, email, NOVA);
  await expect(nova.page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await nova.ctx.close();
});
