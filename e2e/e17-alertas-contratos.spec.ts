import { test, expect } from "@playwright/test";

test("Alertas de contratos — tela abre, janela é escolhida e o '?' leva ao artigo", async ({ page }) => {
  await page.goto("/contratos/alertas");
  await expect(page.getByRole("heading", { name: "Alertas de contratos" })).toBeVisible();
  await page.getByLabel("Avisar com antecedência de").selectOption("90");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/janela=90/);
  await expect(page.getByLabel("Avisar com antecedência de")).toHaveValue("90");
  await page.getByRole("link", { name: "Ajuda desta tela" }).click();
  await expect(page).toHaveURL(/\/ajuda\/alertas-de-contratos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Alertas de contratos" })).toBeVisible();
});

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(60000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };

test("E31 — regra de reajuste, 'Propor reajuste' pré-preenche o aditivo, e adiar/ignorar tira o alerta (e reativar traz de volta)", async ({ page }) => {
  const run = (Date.now() % 90000) + 5000, NOME = `Cliente Reajuste ${run}`;
  // início há ~11 meses e meio: a renovação/reajuste cai dentro de 60 dias
  const d = new Date(); d.setUTCMonth(d.getUTCMonth() - 11); d.setUTCDate(d.getUTCDate() - 10);
  const inicio = d.toISOString().slice(0, 10);
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  await page.goto("/contratos/novo");
  await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
  await page.getByLabel("Serviço contratado").fill("Link dedicado");
  await page.getByLabel("Valor mensal (R$)").fill("2.000,00");
  await page.getByLabel("Dia de vencimento (1–31)").fill("10");
  await page.getByLabel("Início da vigência").fill(inicio);
  await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  await page.getByRole("button", { name: "Aprovar", exact: true }).click();
  await expect(page.getByText("Termos vigentes")).toBeVisible();
  const contratoUrl = page.url();

  await test.step("registra a regra: percentual fixo de 5%", async () => {
    await page.getByLabel("Índice").selectOption("fixo");
    await page.getByLabel("Percentual fixo (%)").fill("5");
    await page.getByRole("button", { name: "Salvar regra" }).click();
    await expect(page.getByText("Regra de reajuste salva.")).toBeVisible();
  });

  await test.step("alerta aparece com a regra; 'Propor reajuste' leva ao aditivo já com +5%", async () => {
    await page.goto("/contratos/alertas?janela=90");
    const item = page.locator("li", { hasText: NOME });
    await expect(item.first()).toBeVisible();
    await expect(item.first()).toContainText("Renovação automática");
    await page.getByLabel(`Percentual de reajuste de ${NOME}`).fill("5");
    await page.getByLabel(`Percentual de reajuste de ${NOME}`).locator("xpath=following-sibling::button").click();
    await expect(page).toHaveURL(/pct=5/);
    await expect(page.getByText(/Reajuste de 5% sobre/)).toBeVisible();
    await expect(page.getByLabel("Valor mensal (R$)")).toHaveValue("2.100,00");
    await expect(page.getByLabel("Tipo", { exact: true })).toHaveValue("reajuste");
  });

  await test.step("ignorar este ciclo tira da lista; reativar traz de volta", async () => {
    await page.goto("/contratos/alertas?janela=90");
    await page.getByRole("button", { name: `Ignorar este ciclo: ${NOME}` }).first().click();
    await expect(page.locator("ul.divide-y.rounded-lg", { hasText: NOME })).toHaveCount(0);
    await page.getByText(/^Silenciados \(/).click();
    await expect(page.getByText(/ignorado neste ciclo/).first()).toBeVisible();
    await page.getByRole("button", { name: "Reativar" }).first().click();
    await expect(page.locator("li", { hasText: NOME }).first()).toBeVisible();
  });
  expect(contratoUrl).toContain("/contratos/");
});
