import { expect, type Browser } from "@playwright/test";

/** E27: abre o link do convite, cria o acesso (nome + senha com confirmação) e já cai logado na Visão executiva. */
export async function aceitarConvite(browser: Browser, path: string, nome: string, senha: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto(path);
  await expect(page.getByText("Você foi convidado para")).toBeVisible();
  await page.getByLabel("Seu nome").fill(nome);
  await page.getByLabel("Nova senha").fill(senha);
  await page.getByLabel("Confirmar senha").fill(senha);
  await page.getByRole("button", { name: "Criar acesso e entrar" }).click();
  await expect(page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  return { ctx, page };
}
