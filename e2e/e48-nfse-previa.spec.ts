import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = (Date.now() + 7) % 100000;
const NOME = `Cliente Previa ${run}`;

test("N2a — prévia da NFS-e: link na cobrança, aviso «só prévia», pendências claras e nada emitido", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  await page.goto("/contratos/novo");
  await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
  await page.getByLabel("Serviço contratado").fill("Suporte com NF");
  await page.getByLabel("Valor mensal (R$)").fill("450,00");
  await page.getByLabel("Dia de vencimento (1–31)").fill("14");
  await page.getByLabel("Início da vigência").fill("2026-01-01");
  await page.getByLabel(/Cliente exige NF emitida junto do boleto/).check();
  await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
  await page.getByRole("button", { name: "Aprovar" }).click();
  await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
  await page.goto("/faturamento/lotes?mes=2026-08");
  await page.locator("li", { hasText: /^01\/08\/2026/ }).getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
  await expect(page.getByText(NOME)).toBeVisible();

  const item = page.locator("li", { hasText: NOME }).filter({ has: page.getByRole("link", { name: "Prévia da NFS-e" }) });
  await item.getByRole("link", { name: "Prévia da NFS-e" }).click();
  await expect(page.getByRole("heading", { name: "Prévia da NFS-e" })).toBeVisible();
  await expect(page.getByText(/Só uma prévia\./)).toBeVisible();
  await expect(page.getByText(/Nada é emitido, assinado nem enviado à prefeitura/)).toBeVisible();
  await expect(page.getByText(NOME).first()).toBeVisible();
  // ou falta algo (lista em português) ou os dados estão completos (XML disponível): nunca um botão de emitir
  const incompleto = await page.getByText("Ainda não dá para montar a nota.").count();
  if (incompleto) {
    await expect(page.getByRole("listitem").filter({ hasText: /tributação nacional|regime tributário|IBGE|CNPJ da empresa/ }).first()).toBeVisible();
    const res = await page.request.get(page.url().replace(/\/$/, "") + "/xml");
    expect(res.status()).toBe(409);
  } else {
    await expect(page.getByText(/passa na validação do leiaute oficial/)).toBeVisible();
    const res = await page.request.get(page.url().replace(/\/$/, "") + "/xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/xml");
    expect(await res.text()).toContain("<tpAmb>2</tpAmb>");
  }
  await expect(page.getByRole("button", { name: /emitir/i })).toHaveCount(0);
});
