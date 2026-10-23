import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Lote ${run}`;

test("E05 — lote: gerar prévia (idempotente), aprovar, mudança de contrato exige reabrir", async ({ page }) => {
  await test.step("cliente + contrato aprovado (vence dia 14 → emite 01/10/2026)", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Suporte N2");
    await page.getByLabel("Valor mensal (R$)").fill("1.234,56");
    await page.getByLabel("Dia de vencimento (1–31)").fill("14");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
  });

  await test.step("lista de datas, aviso de simulação e geração da prévia", async () => {
    await page.goto("/faturamento/lotes?mes=2026-10");
    await expect(page.getByRole("heading", { name: "Lotes de cobrança" })).toBeVisible();
    await expect(page.getByText("não emite").first()).toBeVisible();
    const linha = page.locator("li", { hasText: /^01\/10\/2026/ });
    await linha.getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
    await expect(page.getByRole("heading", { name: "Lote de emissão 01/10/2026" })).toBeVisible();
    await expect(page.getByText(NOME)).toBeVisible();
    await expect(page.getByText(/R\$\s*1\.234,56/).first()).toBeVisible();
    await expect(page.getByText("Prévia", { exact: true }).first()).toBeVisible();
  });

  await test.step("reexecutar a prévia não duplica", async () => {
    const antes = await page.getByText(NOME).count();
    await page.getByRole("button", { name: "Atualizar prévia" }).click();
    await expect(page.getByText("Prévia atualizada.")).toBeVisible();
    expect(await page.getByText(NOME).count()).toBe(antes);
  });

  await test.step("aprovar (diretoria aprova a própria prévia) e screenshot", async () => {
    await page.getByRole("button", { name: "Aprovar lote" }).click();
    await expect(page.getByText(/Lote aprovado\. Nada foi emitido/)).toBeVisible();
    await expect(page.getByText("Aprovado", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprovar lote" })).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.screenshot({ path: "e2e-results/shots/desktop-lote-aprovado.png", fullPage: true });
  });

  await test.step("contrato muda depois da aprovação: lote avisa e exige reabrir com motivo", async () => {
    await page.getByRole("link", { name: NOME }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.getByLabel("Valor mensal (R$)").fill("2.000,00");
    await page.getByRole("button", { name: /Enviar para aprovação|Propor alteração/ }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await page.goto("/faturamento/lotes");
    await page.getByRole("link", { name: /Emissão 01\/10\/2026/ }).click();
    await expect(page.getByText(/Contratos mudaram desde esta aprovação/)).toBeVisible();
    await page.getByLabel("Motivo para reabrir").fill("valor do contrato mudou");
    await page.getByRole("button", { name: "Reabrir para revalidar" }).click();
    await expect(page.getByText(/Lote reaberto/)).toBeVisible();
    await page.getByRole("button", { name: "Atualizar prévia" }).click();
    await expect(page.getByText(/R\$\s*2\.000,00/).first()).toBeVisible();
    await page.getByRole("button", { name: "Aprovar lote" }).click();
    await expect(page.getByText(/Lote aprovado\. Nada foi emitido/)).toBeVisible();
  });
});
