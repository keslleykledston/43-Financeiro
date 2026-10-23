import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(90000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Concilia ${run}`;
const DOC = cnpj(run);
const CONTA = `Conta E2E ${run}`;
const ARQUIVO = `Data;Descrição;Valor;Id\r\n16/10/2026;PIX RECEBIDO ${DOC};1.500,00;E2E${run}A\r\n17/10/2026;TARIFA MENSAL;-39,90;E2E${run}B\r\n`;
const file = { name: "extrato.csv", mimeType: "text/csv", buffer: Buffer.from(ARQUIVO, "utf8") };

test("E08 — conciliação: importar com prévia, sugestão forte, vincular, desfazer, arquivo repetido", async ({ page }) => {
  await test.step("cliente + contrato aprovado (vence dia 25 → emite 15/10/2026) + lote aprovado", async () => {
    await page.goto("/clientes/novo");
    await page.getByLabel("Razão social / nome").fill(NOME);
    await page.getByLabel("CPF ou CNPJ").fill(DOC);
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
    await page.goto("/contratos/novo");
    await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
    await page.getByLabel("Serviço contratado").fill("Monitoramento NOC");
    await page.getByLabel("Valor mensal (R$)").fill("1.500,00");
    await page.getByLabel("Dia de vencimento (1–31)").fill("25");
    await page.getByLabel("Início da vigência").fill("2026-01-01");
    await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
    await page.getByRole("button", { name: "Aprovar" }).click();
    await expect(page.getByText("Ativo", { exact: true }).first()).toBeVisible();
    await page.goto("/faturamento/lotes?mes=2026-10");
    await page.locator("li", { hasText: /^15\/10\/2026/ }).getByRole("button", { name: /Gerar prévia|Atualizar prévia/ }).click();
    await page.getByRole("button", { name: "Aprovar lote" }).click();
    await expect(page.getByText(/Lote aprovado\. Nada foi emitido/)).toBeVisible();
  });

  await test.step("cadastrar a conta (sem número completo) e abrir", async () => {
    await page.goto("/conciliacao");
    await expect(page.getByRole("heading", { name: "Conciliação" })).toBeVisible();
    await expect(page.getByText(/só lê/)).toBeVisible();
    await page.getByLabel("Nome da conta").fill(CONTA);
    await page.getByLabel("Banco", { exact: true }).fill("Cora");
    await page.getByLabel("Saldo inicial (R$)").fill("1.000,00");
    await page.getByLabel("Data do saldo inicial").fill("2026-01-01");
    await page.getByRole("button", { name: "Cadastrar conta" }).click();
    await expect(page.getByText("Conta cadastrada.")).toBeVisible();
    await page.getByRole("link", { name: CONTA }).click();
    await expect(page.getByRole("heading", { name: CONTA })).toBeVisible();
  });

  await test.step("arquivo inválido é recusado com mensagem clara", async () => {
    await page.getByRole("link", { name: "Importar extrato" }).click();
    await page.getByLabel(/Extrato \(OFX ou CSV/).setInputFiles({ name: "ruim.csv", mimeType: "text/csv", buffer: Buffer.from("a;b;c\r\n1;2;3\r\n") });
    await page.getByRole("button", { name: "Analisar arquivo" }).click();
    await expect(page.getByText(/Cabeçalho não reconhecido/)).toBeVisible();
  });

  await test.step("prévia: nada gravado; confirmar importa 2 transações", async () => {
    await page.getByLabel(/Extrato \(OFX ou CSV/).setInputFiles(file);
    await page.getByRole("button", { name: "Analisar arquivo" }).click();
    await expect(page.getByText("Prévia — nada foi gravado ainda")).toBeVisible();
    await expect(page.getByText("Novas", { exact: true })).toBeVisible();
    await expect(page.getByText("Nova", { exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: /Confirmar importação \(2 nova/ }).click();
    await expect(page.getByText(/Importação concluída: 2 transação\(ões\) nova\(s\), 0 repetida/)).toBeVisible();
    await page.screenshot({ path: "e2e-results/shots/desktop-conciliacao-importada.png", fullPage: true });
  });

  await test.step("a lista mostra a sugestão FORTE (documento + valor) e o saldo pelo extrato", async () => {
    await page.goto("/conciliacao");
    await page.getByRole("link", { name: CONTA }).click();
    await expect(page.getByText(`Sugestão forte: ${NOME}`)).toBeVisible();
    await expect(page.getByText(/R\$\s*2\.460,10/).first()).toBeVisible(); // 1.000 + 1.500 − 39,90
  });

  await test.step("conciliar com um clique: baixa em Contas a receber", async () => {
    await page.getByRole("button", { name: `Conciliar com ${NOME}` }).click();
    await expect(page.getByText(/Crédito vinculado\. Cobrança quitada\./)).toBeVisible();
    await page.goto(`/contas-a-receber?status=quitadas&q=${encodeURIComponent(`Concilia ${run}`)}`);
    await expect(page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME })).toBeVisible();
    await page.locator('a[href^="/contas-a-receber/"]', { hasText: NOME }).click();
    await expect(page.getByText("Extrato bancário").first()).toBeVisible();
    await expect(page.getByText(/Registrado por/).first()).toBeVisible();
  });

  await test.step("desfazer o vínculo estorna o pagamento e devolve o saldo", async () => {
    await page.goto("/conciliacao");
    await page.getByRole("link", { name: CONTA }).click();
    await page.getByRole("link", { name: "Conciliadas" }).click();
    await page.getByRole("link", { name: new RegExp(`PIX RECEBIDO ${DOC}`) }).click();
    await page.getByText("Desfazer vínculo").click();
    await page.getByLabel(/Motivo/).fill("teste de desfazer vínculo");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.getByText(/Vínculo desfeito/)).toBeVisible();
    await expect(page.getByText("Desfeito", { exact: true })).toBeVisible();
    await expect(page.getByText("Vincular a uma cobrança")).toBeVisible(); // o crédito voltou a ficar disponível
  });

  await test.step("classificar a tarifa (sem cobrança)", async () => {
    await page.goto("/conciliacao");
    await page.getByRole("link", { name: CONTA }).click();
    await page.getByRole("link", { name: "Débitos" }).click();
    await page.getByRole("link", { name: "TARIFA MENSAL" }).click();
    await page.getByLabel("Classificar como").selectOption("tarifa");
    await page.getByRole("button", { name: "Classificar" }).click();
    await expect(page.getByText("Transação classificada.")).toBeVisible();
    await expect(page.getByText("Tarifa bancária").first()).toBeVisible();
  });

  await test.step("o mesmo arquivo não entra duas vezes", async () => {
    await page.goto("/conciliacao");
    await page.getByRole("link", { name: CONTA }).click();
    await page.getByRole("link", { name: "Importar extrato" }).click();
    await page.getByLabel(/Extrato \(OFX ou CSV/).setInputFiles(file);
    await page.getByRole("button", { name: "Analisar arquivo" }).click();
    await expect(page.getByText(/Este arquivo já foi importado nesta conta/)).toBeVisible();
  });

  await test.step("modelo CSV baixável", async () => {
    const res = await page.request.get("/conciliacao/modelo-csv");
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Data;Descrição;Valor;Id");
  });
});
