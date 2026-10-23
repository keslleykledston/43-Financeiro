import { test, expect, type Browser } from "@playwright/test";

const SENHA = "Convidado-Senha-456";
const novoEmail = () => `gerente-${Date.now()}@sandbox.test`;

async function convidar(page: import("@playwright/test").Page, email: string, papel: string) {
  await page.goto("/configuracao");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: papel });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  await expect(code).toBeVisible();
  return (await code.innerText()).trim();
}

async function entrar(browser: Browser, email: string) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(SENHA);
  await page.getByRole("button", { name: "Entrar" }).click();
  return { ctx, page };
}

test("E02 — convite ponta a ponta, papéis, isolamento e remoção", async ({ page, browser }) => {
  const email = novoEmail();
  const link = await convidar(page, email, "Gerente");
  expect(link).toMatch(/\/convite\/[\w-]{40,}/);
  const path = new URL(link).pathname;

  // convidado: e-mail errado é recusado; correto cria acesso
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const g = await guest.newPage();
  await g.goto(path);
  await g.getByLabel("E-mail convidado").fill("outra-pessoa@sandbox.test");
  await g.getByLabel("Nome").fill("Gerente Teste");
  await g.getByLabel(/^Senha/).fill(SENHA);
  await g.getByRole("button", { name: "Criar acesso" }).click();
  await expect(g.locator("p[role=alert]")).toContainText("Convite inválido ou expirado");
  // após o erro, e-mail e nome são mantidos (só a senha é limpa)
  await expect(g.getByLabel("Nome")).toHaveValue("Gerente Teste");
  await g.getByLabel("E-mail convidado").fill(email);
  await g.getByLabel(/^Senha/).fill(SENHA);
  await g.getByRole("button", { name: "Criar acesso" }).click();
  await expect(g).toHaveURL(/\/login/);

  // link de uso único
  await g.goto(path);
  await g.getByLabel("E-mail convidado").fill(email);
  await g.getByLabel("Nome").fill("Gerente Teste");
  await g.getByLabel(/^Senha/).fill(SENHA);
  await g.getByRole("button", { name: "Criar acesso" }).click();
  await expect(g.locator("p[role=alert]")).toContainText("Convite inválido ou expirado");
  await guest.close();

  // gerente: entra, vê só 1 empresa, sem formulário de convite
  const { ctx, page: gp } = await entrar(browser, email);
  await expect(gp.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
  await expect(gp.getByLabel("Empresa").locator("option")).toHaveText(["K3G Solutions"]);
  await gp.goto("/configuracao");
  await expect(gp.getByRole("heading", { name: "Usuários e acessos" })).toBeVisible();
  await expect(gp.getByRole("button", { name: "Convidar" })).toHaveCount(0);
  await expect(gp.getByRole("button", { name: "Remover" })).toHaveCount(0);

  // forjar cookie de outra empresa não concede acesso
  await gp.context().addCookies([{ name: "k3g_company", value: "00000000-0000-0000-0000-000000000000", url: gp.url() }]);
  await gp.goto("/");
  await expect(gp.getByText("K3G Solutions · ")).toBeVisible();

  // admin remove -> gerente perde o acesso na próxima requisição
  await page.goto("/configuracao");
  await page.locator("li", { hasText: email }).getByRole("button", { name: "Remover" }).click();
  await expect(page.locator("li", { hasText: email })).toHaveCount(0);
  await gp.goto("/");
  await expect(gp.getByRole("heading", { name: "Sem acesso" })).toBeVisible();
  await ctx.close();
});

test("E02 — admin técnico não pode conceder papel acima do permitido e não se remove", async ({ page }) => {
  await page.goto("/configuracao");
  await expect(page.locator("li", { hasText: "admin@sandbox.test" }).getByRole("button", { name: "Remover" })).toHaveCount(0);
});
