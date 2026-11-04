import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(60000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Filtro ${run}`;

test("Lista de clientes: por padrão mostra só os ativos; suspenso some, mas está a um clique em «Todas as situações»", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();

  await page.goto(`/clientes?q=${encodeURIComponent(NOME)}`);
  await expect(page.getByLabel("Situação")).toHaveValue("ativo"); // padrão
  await expect(page.getByRole("link", { name: new RegExp(NOME) })).toBeVisible();

  await page.getByRole("link", { name: new RegExp(NOME) }).click();
  await page.getByRole("link", { name: "Editar", exact: true }).click();
  await page.getByLabel("Situação").selectOption("suspenso");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(page.getByText("Alterações salvas.")).toBeVisible();

  await page.goto(`/clientes?q=${encodeURIComponent(NOME)}`);
  await expect(page.getByText("Nada encontrado para essa busca.")).toBeVisible();
  await expect(page.getByText(/A lista mostra só os\s+ativos/)).toBeVisible();
  await page.getByRole("link", { name: "Ver todas as situações" }).click();
  await expect(page.getByLabel("Situação")).toHaveValue("todas");
  const li = page.getByRole("link", { name: new RegExp(NOME) });
  await expect(li).toBeVisible();
  await expect(li).toContainText("Suspenso");
  await page.getByLabel("Situação").selectOption("suspenso");
  await page.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByRole("link", { name: new RegExp(NOME) })).toBeVisible();
});
