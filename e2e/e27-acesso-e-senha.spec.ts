import { test, expect } from "@playwright/test";
import { aceitarConvite } from "./helpers";

const SENHA = "Convidado-Senha-456", NOVA = "Cavalo-Azul-Torneira-77";
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function convidar(page: import("@playwright/test").Page, email: string, papel: string) {
  await page.goto("/configuracao?aba=usuarios");
  await page.getByLabel("E-mail").first().fill(email);
  await page.getByLabel("Papel").selectOption({ label: papel });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  await expect(code).toBeVisible();
  return new URL((await code.innerText()).trim()).pathname;
}

test("E27 — 'Esqueci minha senha': resposta igual para e-mail existente ou não, sem enviar nada com o e-mail desligado", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByRole("link", { name: "Esqueci minha senha" }).click();
  await expect(p.getByRole("heading", { name: "Esqueci minha senha" })).toBeVisible();
  for (const email of [process.env.SANDBOX_ADMIN_EMAIL!, `nao-existe-${stamp()}@sandbox.test`]) {
    await p.goto("/esqueci-senha");
    await p.getByLabel("E-mail").fill(email);
    await p.getByRole("button", { name: "Enviar link" }).click();
    await expect(p.getByText("Se este e-mail tiver acesso, enviaremos o link")).toBeVisible();
  }
  await ctx.close();
});

test("E27 — link de nova senha gerado pela diretoria: uso único, política, derruba a sessão e a nova senha entra", async ({ page, browser }) => {
  const email = `senha-${stamp()}@sandbox.test`;
  const guest = await aceitarConvite(browser, await convidar(page, email, "Assistente"), "Pessoa Senha", SENHA);
  await page.goto("/configuracao?aba=usuarios");
  const linha = page.locator("li", { hasText: email });
  await linha.getByRole("button", { name: "Link de nova senha" }).click();
  const code = page.getByRole("status").filter({ hasText: "Link de redefinição criado" }).locator("code");
  await expect(code).toBeVisible();
  const path = new URL((await code.innerText()).trim()).pathname;
  expect(path).toMatch(/^\/redefinir\/[\w-]{40,}$/);

  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const r = await anon.newPage();
  await r.goto(path);
  await expect(r.getByRole("heading", { name: "Criar nova senha" })).toBeVisible();
  await expect(r.getByText(/\*+@sandbox\.test/)).toBeVisible(); // e-mail mascarado
  await r.getByLabel("Nova senha").fill("aaaaaaaaaaaaaa");
  await r.getByLabel("Confirmar senha").fill("aaaaaaaaaaaaaa");
  await r.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(r.locator("p[role=alert]")).toContainText("previsível");
  await r.getByLabel("Nova senha").fill(NOVA);
  await r.getByLabel("Confirmar senha").fill(NOVA);
  await r.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(r).toHaveURL(/\/login\?senha=ok/);
  await expect(r.getByText("Senha alterada. Entre com a nova senha.")).toBeVisible();

  // link de uso único
  await r.goto(path);
  await expect(r.getByRole("heading", { name: "Link inválido ou expirado" })).toBeVisible();
  // a sessão aberta antes cai
  await guest.page.goto("/contratos");
  await expect(guest.page).toHaveURL(/\/login/);
  // senha antiga não entra; a nova entra
  await r.goto("/login");
  await r.getByLabel("E-mail").fill(email);
  await r.getByLabel("Senha").fill(SENHA);
  await r.getByRole("button", { name: "Entrar" }).click();
  await expect(r.locator("p[role=alert]")).toBeVisible();
  await r.getByLabel("E-mail").fill(email); // o formulário é limpo depois de cada tentativa
  await r.getByLabel("Senha").fill(NOVA);
  await r.getByRole("button", { name: "Entrar" }).click();
  await expect(r.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await anon.close(); await guest.ctx.close();
});

test("E27 — convites pendentes: novo link invalida o anterior; cancelar tira da lista", async ({ page, browser }) => {
  const email = `pend-${stamp()}@sandbox.test`;
  const antigo = await convidar(page, email, "Contabilidade");
  const lista = page.locator("section", { hasText: "Convites pendentes" });
  const linha = lista.locator("li", { hasText: email });
  await expect(linha).toBeVisible();
  await expect(linha).toContainText("Contabilidade");
  await linha.getByRole("button", { name: "Novo link" }).click();
  const code = lista.getByRole("status").filter({ hasText: "Novo convite criado" }).locator("code");
  await expect(code).toBeVisible();
  const novo = new URL((await code.innerText()).trim()).pathname;
  expect(novo).not.toBe(antigo);

  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const g = await anon.newPage();
  await g.goto(antigo);
  await expect(g.getByRole("heading", { name: "Convite inválido ou expirado" })).toBeVisible();
  await g.goto(novo);
  await expect(g.getByRole("heading", { name: "Criar seu acesso" })).toBeVisible();

  await page.goto("/configuracao?aba=usuarios");
  await page.locator("section", { hasText: "Convites pendentes" }).locator("li", { hasText: email }).getByRole("button", { name: "Cancelar" }).click();
  await expect(page.locator("li", { hasText: email })).toHaveCount(0);
  await g.goto(novo);
  await expect(g.getByRole("heading", { name: "Convite inválido ou expirado" })).toBeVisible();
  await anon.close();
});
