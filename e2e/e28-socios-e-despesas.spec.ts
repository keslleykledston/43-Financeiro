import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(60000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const SOCIO = `Sócio E2E ${run}`;
const CENTRO = `Imóvel ${run}`;

test("D1 — cadastros de despesas: sócio, centro de custo e categoria; categorias padrão já existem", async ({ page }) => {
  await page.goto("/despesas-cadastros");
  await expect(page.getByRole("heading", { name: "Cadastros de despesas" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Configurações" }).getByRole("link", { name: "Despesas" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Nome da categoria: Energia")).toBeVisible();
  await expect(page.getByLabel("Nome da categoria: A classificar (pessoal)")).toBeVisible();
  await page.getByLabel("Nome do novo sócio").fill(SOCIO);
  await page.getByRole("button", { name: "Adicionar sócio" }).click();
  await expect(page.getByLabel(`Nome do sócio: ${SOCIO}`)).toBeVisible();
  await page.getByLabel("Nome do novo centro de custo").fill(CENTRO);
  await page.getByRole("button", { name: "Adicionar centro" }).click();
  await expect(page.getByLabel(`Nome do centro de custo: ${CENTRO}`)).toBeVisible();
  await page.getByLabel("Nome da nova categoria").first().fill(`Seguros ${run}`);
  await page.getByRole("button", { name: "Adicionar categoria" }).first().click();
  await expect(page.getByLabel(`Nome da categoria: Seguros ${run}`)).toBeVisible();
  // sócio repetido é recusado
  await page.getByLabel("Nome do novo sócio").fill(SOCIO.toLowerCase());
  await page.getByRole("button", { name: "Adicionar sócio" }).click();
  await expect(page.getByText("Já existe um sócio com este nome")).toBeVisible();
});

test("D1 — sócios: lançar retirada (a classificar), despesa paga pelo sócio, saldo, estornar e CSV", async ({ page }) => {
  await page.goto("/despesas-cadastros");
  const s2 = `Sócia E2E ${run}`;
  await page.getByLabel("Nome do novo sócio").fill(s2);
  await page.getByRole("button", { name: "Adicionar sócio" }).click();
  await page.goto("/socios");
  await expect(page.getByRole("heading", { name: "Sócios e retiradas" })).toBeVisible();
  const card = page.locator("section[aria-label='Saldo dos sócios'] > div", { hasText: s2 });
  await expect(card).toContainText("sem saldo");

  await page.getByLabel("Sócio", { exact: true }).first().selectOption({ label: s2 });
  await page.getByLabel("Valor (R$)").fill("1.000,00");
  await page.getByLabel("Descrição").fill("Fatura cartão pessoal");
  await page.getByRole("button", { name: "Registrar lançamento" }).click();
  await expect(page.getByText("Lançamento registrado.")).toBeVisible();
  await expect(card).toContainText("R$ 1.000,00");
  await expect(card).toContainText("o sócio deve à empresa");
  await expect(card).toContainText("1 lançamento(s) a classificar");

  await page.getByLabel("Tipo").selectOption("despesa_paga_pelo_socio");
  await page.getByLabel("Sócio", { exact: true }).first().selectOption({ label: s2 });
  await page.getByLabel("Valor (R$)").fill("400,00");
  await page.getByLabel("Descrição").fill("Compra da empresa no cartão PF");
  await page.getByRole("button", { name: "Registrar lançamento" }).click();
  await expect(card).toContainText("R$ 600,00");

  const linha = page.locator("tr", { hasText: "Fatura cartão pessoal" });
  await expect(linha).toContainText("a classificar");
  await expect(linha).toContainText("− R$ 1.000,00");
  await linha.getByText("Estornar").click();
  await linha.getByLabel("Motivo do estorno").fill("sócio errado");
  await linha.getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByText("Lançamento estornado.")).toBeVisible();
  await expect(card).toContainText("R$ 400,00");
  await expect(card).toContainText("a empresa deve ao sócio");

  const csv = await page.request.get("/socios/exportar");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain("efeito_no_saldo");
});

test("D1 — contas a pagar com categoria, centro de custo e competência", async ({ page }) => {
  const forn = `Fornecedor D1 ${run}`;
  await page.goto("/clientes/novo");
  await page.getByLabel("Tipo").selectOption("fornecedor");
  await page.getByLabel("Razão social / nome").fill(forn);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: forn })).toBeVisible();
  await page.goto("/despesas-cadastros");
  await page.getByLabel("Nome do novo centro de custo").fill(`Centro D1 ${run}`);
  await page.getByRole("button", { name: "Adicionar centro" }).click();

  await page.goto("/contas-a-pagar/novo");
  await page.getByLabel("Fornecedor").selectOption({ label: forn });
  await page.getByLabel("Descrição da despesa").fill("Energia outubro");
  await page.getByLabel("Categoria").selectOption({ label: "Energia" });
  await page.getByLabel("Centro de custo").selectOption({ label: `Centro D1 ${run}` });
  await page.getByLabel("Mês de competência").fill("2026-10");
  await page.getByLabel("Valor (R$)").fill("321,00");
  await page.getByLabel("Vencimento").fill("2026-11-05");
  await page.getByRole("button", { name: "Salvar como rascunho" }).click();
  await expect(page.getByText("Conta lançada como rascunho.")).toBeVisible();
  await expect(page.getByText(`Energia · Centro D1 ${run} · competência 10/2026`)).toBeVisible();
});
