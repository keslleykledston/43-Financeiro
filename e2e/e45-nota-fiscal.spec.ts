import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Nota ${run}`;
const PDF = Buffer.from(`%PDF-1.4\n% nota de teste ${"x".repeat(300)}\n%%EOF`);

test("N1 — cobrança «boleto + NF»: aviso de nota faltando, anexar PDF, baixar, trocar e remover", async ({ page }) => {
  await test.step("cliente + contrato que exige NF junto (vence dia 14/07 → lote de 01/07) + lote", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Link IP com NF");
    await page.getByLabel("Valor mensal (R$)").fill("900,00");
    await page.getByLabel("Dia de vencimento (1–31)").fill("14");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByLabel(/Cliente exige NF emitida junto do boleto/).check();
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
    await page.goto("/faturamento/lotes?mes=2026-07");
    await page.locator("li", { hasText: /^01\/07\/2026/ }).getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
    await expect(page.getByText(NOME)).toBeVisible();
  });

  await test.step("sem nota: aviso no topo e na cobrança", async () => {
    await expect(page.getByText(/exige\(m\) boleto \+ nota fiscal e ainda não tem a nota anexada/)).toBeVisible();
    await expect(page.getByText("Falta a nota fiscal: o e-mail desta cobrança espera por ela.")).toBeVisible();
  });

  await test.step("recusa arquivo que não é PDF", async () => {
    await page.getByText("Anexar a nota fiscal").click();
    await page.getByLabel("Número da nota").fill("2026/77");
    await page.getByLabel("Emitida em").fill("2026-06-30");
    await page.locator('input[name="file"]').setInputFiles({ name: "nota.pdf", mimeType: "application/pdf", buffer: Buffer.from("isto não é um pdf, é só texto ".repeat(10)) });
    await page.getByRole("button", { name: "Anexar", exact: true }).click();
    await expect(page.getByText("O arquivo da nota precisa ser um PDF")).toBeVisible();
  });

  await test.step("anexa o PDF: some o aviso, aparece a nota e o download funciona", async () => {
    await page.getByText("Anexar a nota fiscal").click();
    await page.getByLabel("Número da nota").fill("2026/77");
    await page.getByLabel("Emitida em").fill("2026-06-30");
    await page.getByLabel(/Código de verificação/).fill("ABCD-1234");
    await page.locator('input[name="file"]').setInputFiles({ name: "nota.pdf", mimeType: "application/pdf", buffer: PDF });
    await page.getByRole("button", { name: "Anexar", exact: true }).click();
    await expect(page.getByText(/Nota fiscal anexada\. O e-mail desta cobrança passa a levar boleto e nota juntos/)).toBeVisible();
    await expect(page.getByText("2026/77", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/Falta a nota fiscal/)).toHaveCount(0);
    const res = await page.request.get(await page.getByRole("link", { name: "Baixar PDF" }).getAttribute("href") as string);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");
  });

  await test.step("substitui e remove: volta o aviso", async () => {
    await page.getByText("Substituir a nota").click();
    await page.getByLabel("Número da nota").fill("2026/78");
    await page.getByLabel("Emitida em").fill("2026-06-30");
    await page.locator('input[name="file"]').setInputFiles({ name: "nota2.pdf", mimeType: "application/pdf", buffer: PDF });
    await page.getByRole("button", { name: "Substituir", exact: true }).click();
    await expect(page.getByText(/Nota fiscal substituída/)).toBeVisible();
    await expect(page.getByText("2026/78").first()).toBeVisible();
    await page.getByRole("button", { name: "Remover", exact: true }).click();
    await expect(page.getByText("Nota fiscal removida desta cobrança.")).toBeVisible();
    await expect(page.getByText("Falta a nota fiscal: o e-mail desta cobrança espera por ela.")).toBeVisible();
    await page.screenshot({ path: "e2e-results/shots/desktop-nota-fiscal.png", fullPage: true });
  });
});
