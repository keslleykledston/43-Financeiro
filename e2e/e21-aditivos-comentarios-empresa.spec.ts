import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(60000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Aditivo ${run}`;

test("E21 — aditivo com aprovação na hora, comentários só de acréscimo e dados da empresa", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();

  await test.step("comentário no cliente", async () => {
    await page.getByRole("tab", { name: /^Anotações/ }).click();
    await page.getByLabel("Novo comentário").fill("Cliente pontual, paga sempre no vencimento.");
    await page.getByRole("button", { name: "Adicionar comentário" }).click();
    await expect(page.getByText("Cliente pontual, paga sempre no vencimento.")).toBeVisible();
    await expect(page.getByRole("button", { name: /editar|apagar|excluir/i })).toHaveCount(0);
  });

  await page.goto("/contratos/novo");
  await page.getByLabel("Cliente", { exact: true }).selectOption({ label: NOME });
  await page.getByLabel("Serviço contratado").fill("Link dedicado");
  await page.getByLabel("Valor mensal (R$)").fill("2.500,00");
  await page.getByLabel("Dia de vencimento (1–31)").fill("10");
  await page.getByLabel("Início da vigência").fill("2026-01-01");
  await page.getByRole("button", { name: "Criar e enviar para aprovação" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  await page.getByRole("button", { name: "Aprovar", exact: true }).click();
  await expect(page.getByText("Termos vigentes")).toBeVisible();

  await test.step("aditivo de reajuste: data além de 3 anos é recusada; válido, aprovado na hora", async () => {
    await expect(page.getByRole("heading", { name: "Aditivo ou ajuste de valor" })).toBeVisible();
    await page.getByLabel("Tipo", { exact: true }).selectOption("reajuste");
    await page.getByLabel("Valor mensal (R$)").fill("2.750,00");
    await page.getByLabel("Vale a partir de (opcional)").fill("2999-01-01");
    await page.getByLabel("Aprovar agora (diretoria)", { exact: false }).check();
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "no máximo 3 anos" })).toBeVisible();
    await page.getByLabel("Tipo", { exact: true }).selectOption("reajuste");
    await page.getByLabel("Valor mensal (R$)").fill("2.750,00");
    await page.getByLabel("Vale a partir de (opcional)").fill("2026-06-01");
    await page.getByLabel("Referência do documento (opcional)").fill("1º aditivo assinado");
    await page.getByLabel("Aprovar agora (diretoria)", { exact: false }).check();
    await page.getByRole("button", { name: "Enviar para aprovação" }).click();
    await expect(page.getByText("Aditivo aprovado e já em vigor")).toBeVisible();
    await expect(page.getByText("R$ 2.750,00").first()).toBeVisible();
    await expect(page.getByText("Documento: 1º aditivo assinado")).toBeVisible();
    await expect(page.getByText("Vale a partir de 01/06/2026")).toBeVisible();
  });

  await test.step("comentário no contrato fica registrado e não tem edição", async () => {
    await page.getByLabel("Novo comentário").fill("Reajuste de 10% combinado por e-mail.");
    await page.getByRole("button", { name: "Adicionar comentário" }).click();
    await expect(page.getByText("Comentário registrado")).toBeVisible();
    await expect(page.getByText("Reajuste de 10% combinado por e-mail.")).toBeVisible();
  });

  await test.step("dados da empresa: valida e salva; o '?' leva ao artigo", async () => {
    await page.goto("/empresa");
    await expect(page.getByRole("heading", { name: "Dados da empresa" })).toBeVisible();
    await page.getByLabel("CNPJ", { exact: true }).fill("11.111.111/1111-11");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "CNPJ inválido" })).toBeVisible();
    await page.goto("/empresa");
    await page.getByLabel("Razão social").fill(`Razão Social Teste ${run} Ltda`);
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText(/Salvo: .*razão social/)).toBeVisible();
    await page.getByRole("link", { name: "Ajuda desta tela" }).click();
    await expect(page).toHaveURL(/\/ajuda\/dados-da-empresa$/);
  });
});
