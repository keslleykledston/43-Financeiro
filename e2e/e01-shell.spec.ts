import { test, expect } from "@playwright/test";

const ROTAS = ["/", "/clientes", "/contratos", "/faturamento", "/faturamento/lotes", "/faturamento/ajustes", "/contratos/importar", "/contratos/alertas", "/empresa", "/historico", "/comissoes", "/faturamento/emissoes", "/mensagens", "/mensagens/modelos", "/mensagens/configuracao", "/conta", "/auditoria", "/ajuda", "/ajuda/importar-contratos", "/contas-a-receber", "/contas-a-pagar", "/contas-a-pagar/novo", "/contas-a-pagar/execucao", "/conciliacao", "/integracoes", "/configuracao"];
const anon = { cookies: [], origins: [] };

test.describe("E01 — acesso anônimo", () => {
  test.use({ storageState: anon });

  for (const r of ROTAS) {
    test(`anônimo em ${r} vai para /login`, async ({ page }) => {
      await page.goto(r);
      await expect(page).toHaveURL(/\/login/);
    });
  }

  test("senha errada mostra erro genérico e não entra", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(process.env.SANDBOX_ADMIN_EMAIL!);
    await page.getByLabel("Senha").fill("senha-errada-123456");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.locator("p[role=alert]")).toHaveText("E-mail ou senha inválidos.");
    await expect(page).toHaveURL(/\/login/);
  });

  test("health é público e não vaza dados", async ({ request }) => {
    const r = await request.get("/api/v1/health");
    expect(r.ok()).toBe(true);
    expect(await r.json()).toEqual({ status: "ok" });
  });
});

test.describe("E01 — shell autenticado", () => {
  test("dashboard com números reais e ambiente marcado como validação", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Visão executiva" })).toBeVisible();
    await expect(page.getByRole("status").first()).toContainText("VALIDAÇÃO");
    await expect(page.getByText("números reais").first()).toBeVisible();
  });

  for (const r of ROTAS) {
    test(`rota ${r} abre sem 404`, async ({ page }) => {
      const resp = await page.goto(r);
      expect(resp?.status()).toBe(200);
      await expect(page.getByRole("heading").first()).toBeVisible();
      await expect(page.getByText("This page could not be found")).toHaveCount(0);
    });
  }

  test("seletor lista as 2 empresas do admin", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Empresa").locator("option")).toHaveText(["K3G Solutions", "K3G Call"]);
  });

  test("trocar de empresa muda o contexto do dashboard", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Empresa").selectOption({ label: "K3G Call" });
    await page.getByRole("button", { name: "Trocar" }).click();
    await expect(page.getByText("K3G Call · ")).toBeVisible();
  });

  test("sair encerra a sessão", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sair" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/clientes");
    await expect(page).toHaveURL(/\/login/);
  });
});
