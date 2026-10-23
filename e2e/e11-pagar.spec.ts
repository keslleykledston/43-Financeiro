import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(50000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const FORN = `Fornecedor Pagar ${run}`;
const DOCNUM = `NF-${run}`;

test("E11 — contas a pagar: lançar, duplicidade, aprovar com segregação, fila de execução, baixa manual, estorno", async ({ page }) => {
  await test.step("cadastrar fornecedor", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Tipo").selectOption("fornecedor");
    await page.getByLabel("Razão social / nome").fill(FORN);
    await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: FORN })).toBeVisible();
  });

  await test.step("lançar como rascunho", async () => {
    await page.goto("/contas-a-pagar/novo");
    await expect(page.getByText(/não executa pagamentos|O pagamento em si é feito no banco/).first()).toBeVisible();
    await page.getByLabel("Fornecedor").selectOption({ label: FORN });
    await page.getByLabel("Descrição da despesa").fill("Link dedicado outubro");
    await page.getByLabel(/Nº do documento/).fill(DOCNUM);
    await page.getByLabel("Valor (R$)").fill("1.200,00");
    await page.getByLabel("Vencimento").fill("2026-11-10");
    await page.getByRole("button", { name: "Salvar como rascunho" }).click();
    await expect(page.getByText("Conta lançada como rascunho.")).toBeVisible();
    await expect(page.getByText("Rascunho", { exact: true }).first()).toBeVisible();
  });

  await test.step("segunda conta com o MESMO documento é barrada; mesmo valor/vencimento pede confirmação", async () => {
    await page.goto("/contas-a-pagar/novo");
    await page.getByLabel("Fornecedor").selectOption({ label: FORN });
    await page.getByLabel("Descrição da despesa").fill("Repetida");
    await page.getByLabel(/Nº do documento/).fill(DOCNUM);
    await page.getByLabel("Valor (R$)").fill("999,00");
    await page.getByLabel("Vencimento").fill("2026-11-20");
    await page.getByRole("button", { name: "Salvar como rascunho" }).click();
    await expect(page.getByText(/com este número de documento/)).toBeVisible();
    await page.getByLabel(/Nº do documento/).fill(`${DOCNUM}-B`);
    await page.getByLabel("Valor (R$)").fill("1.200,00");
    await page.getByLabel("Vencimento").fill("2026-11-10");
    await page.getByRole("button", { name: "Salvar como rascunho" }).click();
    await expect(page.getByText(/mesmo valor e vencimento/)).toBeVisible();
    await expect(page.getByLabel(/não é a mesma conta/)).toBeVisible(); // exige confirmação explícita
  });

  await test.step("enviar a primeira conta e ver que quem lançou não aprova", async () => {
    await page.goto("/contas-a-pagar?status=rascunhos&q=" + encodeURIComponent(FORN));
    await page.getByRole("link", { name: FORN }).first().click();
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText("Enviada para aprovação.")).toBeVisible();
    await expect(page.getByText(/Você lançou esta conta/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Aprovar", exact: true })).toBeDisabled();
  });

  await test.step("diretoria libera a auto-aprovação (fica registrado) e aprova; vai para a fila de execução", async () => {
    await page.goto("/contas-a-pagar");
    await page.getByLabel(/Diretoria pode aprovar/).check();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();
    await page.goto("/contas-a-pagar?status=aguardando&q=" + encodeURIComponent(FORN));
    await page.getByRole("link", { name: FORN }).first().click();
    await page.getByRole("button", { name: "Aprovar", exact: true }).click();
    await expect(page.getByText(/Conta aprovada\. Ela entrou na fila de execução/)).toBeVisible();
    await page.goto("/contas-a-pagar/execucao");
    await expect(page.getByText(/não paga nada/)).toBeVisible();
    await expect(page.getByRole("link", { name: FORN }).first()).toBeVisible();
    const csv = await page.request.get("/contas-a-pagar/exportar?fila=1");
    expect(csv.status()).toBe(200); expect(csv.headers()["content-disposition"]).toContain("attachment");
    expect(await csv.text()).toContain(FORN);
  });

  await test.step("baixa manual parcial → parcial; acima do saldo é recusada; completar → paga", async () => {
    await page.goto("/contas-a-pagar/execucao");
    await page.getByRole("link", { name: FORN }).first().click();
    await page.getByLabel("Valor pago (R$)").fill("200,00");
    await page.getByLabel("Protocolo / comprovante").fill("PROT-123");
    await page.getByRole("button", { name: "Registrar baixa" }).click();
    await expect(page.getByText("Baixa registrada.")).toBeVisible();
    await expect(page.getByText("Parcialmente paga").first()).toBeVisible();
    await page.getByLabel("Valor pago (R$)").fill("1.000,01");
    await page.getByRole("button", { name: "Registrar baixa" }).click();
    await expect(page.getByText(/passa do saldo em aberto \(R\$\s*1\.000,00\)/)).toBeVisible();
    await page.getByLabel("Valor pago (R$)").fill("1.000,00");
    await page.getByRole("button", { name: "Registrar baixa" }).click();
    await expect(page.getByText("Baixa registrada. Conta paga.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar baixa" })).toHaveCount(0);
    await expect(page.getByText(/protocolo PROT-123/)).toBeVisible();
  });

  await test.step("estorno exige motivo, mantém histórico e devolve o saldo; conta com baixa não cancela", async () => {
    await page.getByText("Estornar baixa").first().click();
    await page.getByLabel(/Motivo/).first().fill("baixa lançada no valor errado");
    await page.getByRole("button", { name: "Confirmar estorno" }).click();
    await expect(page.getByText(/Baixa estornada/)).toBeVisible();
    await expect(page.getByText("Estornada", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Registrar baixa" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancelar conta" })).toHaveCount(0); // há histórico de baixas
    await page.screenshot({ path: "e2e-results/shots/desktop-pagar-conta.png", fullPage: true });
  });

  await test.step("painel mostra A pagar e restaura a configuração padrão", async () => {
    await page.goto("/");
    await expect(page.locator('section[aria-label="Indicadores"]').getByRole("link", { name: /^A pagar \(aprovadas\)/ })).toBeVisible();
    await page.goto("/contas-a-pagar");
    await page.getByLabel(/Diretoria pode aprovar/).uncheck();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();
  });
});
