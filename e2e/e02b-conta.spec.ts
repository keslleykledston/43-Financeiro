import { test, expect, type Browser } from "@playwright/test";
import { aceitarConvite } from "./helpers";

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
  await page.goto("/configuracao?aba=usuarios");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: "Assistente" });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  const path = new URL((await code.innerText()).trim()).pathname;

  const guest = await aceitarConvite(browser, path, "Usuária Conta", ANTIGA); // E27: já entra ao criar a senha
  await guest.ctx.close();

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
  // a sessão que trocou a senha também cai: a próxima navegação pede login de novo
  await u.goto("/contratos");
  await expect(u).toHaveURL(/\/login/);
  await ctx.close();

  // senha antiga deixa de valer; a nova entra
  const velha = await entrar(browser, email, ANTIGA);
  await expect(velha.page.locator("p[role=alert]")).toBeVisible();
  await velha.ctx.close();
  const nova = await entrar(browser, email, NOVA);
  await expect(nova.page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await nova.ctx.close();
});

test("Minha conta — 'Sair em todos os dispositivos' derruba a sessão (usuário convidado, não o admin compartilhado)", async ({ page, browser }) => {
  const email = `sessoes-${Date.now()}@sandbox.test`;
  await page.goto("/configuracao?aba=usuarios");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: "Assistente" });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  const path = new URL((await code.innerText()).trim()).pathname;
  const guest = await aceitarConvite(browser, path, "Usuária Sessões", ANTIGA);
  await guest.ctx.close();

  // dois "aparelhos" com a mesma conta
  const a = await entrar(browser, email, ANTIGA), b = await entrar(browser, email, ANTIGA);
  await expect(a.page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await expect(b.page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await a.page.goto("/conta");
  await a.page.getByRole("button", { name: "Sair em todos os dispositivos" }).click();
  await expect(a.page).toHaveURL(/\/login/);
  await b.page.goto("/contratos");
  await expect(b.page).toHaveURL(/\/login/);
  const c = await entrar(browser, email, ANTIGA); // login novo funciona
  await expect(c.page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await a.ctx.close(); await b.ctx.close(); await c.ctx.close();
});
