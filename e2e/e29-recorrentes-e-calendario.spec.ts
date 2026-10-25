import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const FORN = `Fornecedor D2 ${run}`;
const now = new Date();
const MES = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

test("D2 — recorrentes e parcelas: cadastrar, ver compromissos, gerar o mês no calendário sem duplicar", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Tipo").selectOption("fornecedor");
  await page.getByLabel("Razão social / nome").fill(FORN);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: FORN })).toBeVisible();

  await page.goto("/contas-a-pagar/recorrentes");
  await expect(page.getByRole("heading", { name: "Recorrentes e parcelas" })).toBeVisible();
  const novaRec = page.locator("form", { hasText: "Nova conta recorrente" });
  await novaRec.getByLabel("Fornecedor").selectOption({ label: FORN });
  await novaRec.getByLabel("Descrição").fill(`Internet ${run}`);
  await novaRec.getByLabel("Valor esperado (R$)").fill("2.000,00");
  await novaRec.getByLabel("Dia do vencimento").fill("28");
  await novaRec.getByLabel("A partir de").fill(MES);
  await novaRec.getByRole("button", { name: "Cadastrar conta recorrente" }).click();
  await expect(page.getByText("Modelo salvo.")).toBeVisible();
  await expect(page.getByText(`Internet ${run}`).first()).toBeVisible();

  const novaSerie = page.locator("form", { hasText: "Novo parcelamento" });
  await novaSerie.getByLabel("Fornecedor").selectOption({ label: FORN });
  await novaSerie.getByLabel("Descrição").fill(`Consórcio ${run}`);
  await novaSerie.getByLabel("Nº de parcelas").fill("12");
  await novaSerie.getByLabel("Primeiro vencimento").fill(`${MES}-27`);
  await novaSerie.getByLabel("Valor de cada parcela (R$)").fill("583,54");
  await novaSerie.getByRole("button", { name: "Cadastrar parcelamento" }).click();
  await expect(page.getByText("Parcelamento cadastrado.")).toBeVisible();
  const linha = page.locator("tr", { hasText: `Consórcio ${run}` });
  await expect(linha).toContainText("12");
  await expect(linha).toContainText("R$ 583,54 × 12");
  await expect(linha).toContainText("R$ 7.002,48"); // 12 × 583,54 restantes

  // valor esperado do modelo pode ser ajustado
  const item = page.locator("li", { hasText: `Internet ${run}` });
  await item.getByLabel(/Valor esperado: Internet/).fill("2.100,00");
  await item.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Modelo salvo.")).toBeVisible();
  await expect(page.locator("li", { hasText: `Internet ${run}` }).getByLabel(/Valor esperado: Internet/)).toHaveValue("2100,00");

  // calendário: previstas aparecem, gerar cria rascunhos, repetir não duplica
  await page.goto(`/contas-a-pagar/calendario?mes=${MES}`);
  await expect(page.getByRole("heading", { name: "Calendário de pagamentos" })).toBeVisible();
  await expect(page.getByText(`Internet ${run}`)).toBeVisible();
  await expect(page.getByText(`Consórcio ${run} 1/12`)).toBeVisible();
  await page.getByRole("button", { name: "Gerar o mês" }).click();
  await expect(page.getByText(/Rascunhos gerados: \d+/)).toBeVisible();
  await expect(page.getByText(`Internet ${run}`)).toBeVisible();
  await expect(page.getByText("Rascunho", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("recorrente prevista")).toHaveCount(0);
  await expect(page.getByText("parcela prevista")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Gerar o mês" })).toHaveCount(0); // nada a gerar
  await page.getByRole("link", { name: new RegExp(FORN) }).first().click();
  await expect(page.getByRole("heading", { name: /Internet|Consórcio|Fornecedor/ }).first()).toBeVisible();
});
