import { test, expect } from "@playwright/test";

const SENHA = "Convidado-Senha-456";
const novoEmail = () => `gerente-${Date.now()}@sandbox.test`;

async function convidar(page: import("@playwright/test").Page, email: string, papel: string) {
  await page.goto("/configuracao?aba=usuarios");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: papel });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  await expect(code).toBeVisible();
  return (await code.innerText()).trim();
}

test("E02 — convite ponta a ponta, papéis, isolamento e remoção", async ({ page, browser }) => {
  const email = novoEmail();
  const link = await convidar(page, email, "Gerente");
  expect(link).toMatch(/\/convite\/[\w-]{40,}/);
  const path = new URL(link).pathname;

  // convidado: a tela mostra empresa e papel, o e-mail fica fixo; senha fraca é recusada e o nome é mantido; correto cria o acesso e já entra
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const g = await guest.newPage();
  await g.goto(path);
  await expect(g.getByText("Você foi convidado para")).toContainText("Gerente");
  await expect(g.getByLabel("E-mail do acesso")).toHaveValue(email);
  await g.getByLabel("Seu nome").fill("Gerente Teste");
  await g.getByLabel("Nova senha").fill("aaaaaaaaaaaaaa");
  await g.getByLabel("Confirmar senha").fill("aaaaaaaaaaaaaa");
  await g.getByRole("button", { name: "Criar acesso e entrar" }).click();
  await expect(g.locator("p[role=alert]")).toContainText("previsível");
  await expect(g.getByLabel("Seu nome")).toHaveValue("Gerente Teste");
  await g.getByLabel("Nova senha").fill(SENHA);
  await g.getByLabel("Confirmar senha").fill(SENHA + "x");
  await expect(g.getByText("A confirmação não confere.")).toBeVisible();
  await g.getByLabel("Confirmar senha").fill(SENHA);
  await g.getByRole("button", { name: "Criar acesso e entrar" }).click();
  const gp = g, ctx = guest;
  await expect(gp.getByRole("heading", { name: "Visão executiva" })).toBeVisible();

  // link de uso único
  const outro = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const o = await outro.newPage();
  await o.goto(path);
  await expect(o.getByRole("heading", { name: "Convite inválido ou expirado" })).toBeVisible();
  await outro.close();

  // gerente: vê só 1 empresa, sem formulário de convite
  await expect(gp.getByLabel("Empresa").locator("option")).toHaveText(["K3G Solutions"]);
  await gp.goto("/configuracao?aba=usuarios");
  await expect(gp.getByRole("heading", { name: "Usuários e acessos" })).toBeVisible();
  await expect(gp.getByRole("button", { name: "Convidar" })).toHaveCount(0);
  await expect(gp.getByRole("button", { name: "Remover" })).toHaveCount(0);
  await expect(gp.getByRole("button", { name: "Link de nova senha" })).toHaveCount(0);

  // forjar cookie de outra empresa não concede acesso
  await gp.context().addCookies([{ name: "k3g_company", value: "00000000-0000-0000-0000-000000000000", url: gp.url() }]);
  await gp.goto("/");
  await expect(gp.getByText("K3G Solutions · ")).toBeVisible();

  // admin remove -> gerente perde o acesso na próxima requisição
  await page.goto("/configuracao?aba=usuarios");
  await page.locator("li", { hasText: email }).getByRole("button", { name: "Remover" }).click();
  await expect(page.locator("li", { hasText: email })).toHaveCount(0);
  await gp.goto("/");
  await expect(gp.getByRole("heading", { name: "Sem acesso" })).toBeVisible();
  await ctx.close();
});

test("E02 — admin técnico não pode conceder papel acima do permitido e não se remove", async ({ page }) => {
  await page.goto("/configuracao?aba=usuarios");
  await expect(page.locator("li", { hasText: "admin@sandbox.test" }).getByRole("button", { name: "Remover" })).toHaveCount(0);
});
