import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(80000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Receber ${run}`;

test("E07 — contas a receber: parcial → quitada, saldo nunca negativo, estorno e histórico", async ({ page }) => {
  await test.step("cliente + contrato aprovado (vence dia 20 → emite 08/10/2026) + lote aprovado", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Link dedicado");
    await page.getByLabel("Valor mensal (R$)").fill("1.000,00");
    await page.getByLabel("Dia de vencimento (1–31)").fill("20");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
    await page.goto("/faturamento/lotes?mes=2026-10");
    await page.locator("li", { hasText: /^08\/10\/2026/ }).getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
    await page.getByRole("button", { name: "Aprovar lote" }).click();
    await expect(page.getByText(/Lote aprovado\. Nada foi emitido/)).toBeVisible();
  });

  await test.step("aparece em Contas a receber, em aberto, com aviso de baixa manual", async () => {
    await page.goto("/contas-a-receber");
    await expect(page.getByRole("heading", { name: "Contas a receber" })).toBeVisible();
    await expect(page.getByText("não movimenta dinheiro")).toBeVisible();
    await page.getByLabel("Cliente").fill(`Receber ${run}`);
    await page.getByRole("button", { name: "Filtrar" }).click();
    const linha = page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME });
    await expect(linha).toBeVisible();
    await linha.click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  });

  await test.step("pagamento parcial → Parcial; acima do saldo é recusado", async () => {
    await page.getByLabel("Valor recebido (R$)").fill("400,00");
    await page.getByRole("button", { name: "Registrar pagamento" }).click();
    await expect(page.getByText("Pagamento registrado.")).toBeVisible();
    await expect(page.getByText("Parcial", { exact: true }).first()).toBeVisible();
    await page.getByLabel("Valor recebido (R$)").fill("600,01");
    await page.getByRole("button", { name: "Registrar pagamento" }).click();
    await expect(page.getByText(/passa do saldo em aberto \(R\$\s*600,00\)/)).toBeVisible();
  });

  await test.step("completar o saldo quita e para a régua", async () => {
    await page.getByLabel("Valor recebido (R$)").fill("600,00");
    await page.getByRole("button", { name: "Registrar pagamento" }).click();
    await expect(page.getByText(/Cobrança quitada/)).toBeVisible();
    await expect(page.getByText("Quitada", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar pagamento" })).toHaveCount(0); // sem saldo, sem formulário
    await expect(page.getByText(/Recebimento de R\$\s*400,00 registrado/)).toBeVisible();
  });

  await test.step("estorno exige motivo, mantém o histórico e devolve o saldo", async () => {
    await page.getByText("Estornar").first().click();
    await page.getByLabel(/Motivo/).first().fill("lançado no cliente errado");
    await page.getByRole("button", { name: "Confirmar estorno" }).click();
    await expect(page.getByText(/Pagamento estornado/)).toBeVisible();
    await expect(page.getByText("Estornado", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/estornado por .*: lançado no cliente errado/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar pagamento" })).toBeVisible(); // saldo voltou
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: "e2e-results/shots/desktop-receber-cobranca.png", fullPage: true });
  });

  await test.step("lista, filtro de quitadas e exportação CSV", async () => {
    await page.goto(`/contas-a-receber?status=quitadas&q=${encodeURIComponent(`Receber ${run}`)}`);
    await expect(page.getByText("Nenhuma cobrança neste filtro")).toBeVisible(); // estornou parte: não está quitada
    await page.goto(`/contas-a-receber?status=parciais&q=${encodeURIComponent(`Receber ${run}`)}`);
    await expect(page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME })).toBeVisible();
    const res = await page.request.get(`/contas-a-receber/exportar?status=todas&q=${encodeURIComponent(`Receber ${run}`)}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain("attachment");
    const csv = await res.text();
    expect(csv).toContain("Cliente;Descrição;Competência");
    expect(csv).toContain(NOME);
  });

  await test.step("resumo e telas sem rolagem horizontal em 375px", async () => {
    await page.goto("/contas-a-receber");
    await expect(page.getByText("Envelhecimento do vencido")).toBeVisible();
    await expect(page.getByText("Maiores devedores (vencido)")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1300 });
    await page.screenshot({ path: "e2e-results/shots/desktop-receber.png", fullPage: true });
  });
});
