import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(50000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Edicao ${run}`;

test("Cliente > Editar: dados, endereço, nota fiscal e boleto, anotações e contatos na mesma caixa", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Editar" })).toBeVisible();
  for (const t of ["Dados", "Endereço", "Nota fiscal e boleto", /^Anotações/, /^Contatos/]) await expect(page.getByRole("tab", { name: t })).toBeVisible();

  await test.step("dados com validador de CNPJ", async () => {
    await page.getByLabel("CPF ou CNPJ").fill("22.991.939/0001-60");
    await expect(page.getByText(/dígitos verificadores do CNPJ não conferem/)).toBeVisible();
    await page.getByRole("button", { name: "22.991.939/0001-06" }).click();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Alterações salvas.")).toBeVisible();
    await expect(page.getByText("CNPJ 22.991.939/0001-06").first()).toBeVisible();
  });

  await test.step("endereço", async () => {
    await page.getByRole("tab", { name: "Endereço" }).click();
    await page.getByLabel("CEP").fill("123");
    await page.getByRole("button", { name: "Salvar endereço" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "CEP deve ter 8 dígitos" })).toBeVisible();
    await page.getByLabel("CEP").fill("69000-000");
    await page.getByLabel("Logradouro").fill("Av. Exemplo");
    await page.getByLabel("Município", { exact: true }).fill("Manaus");
    await page.getByLabel("UF").fill("am");
    await page.getByRole("button", { name: "Salvar endereço" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Salvo: .*CEP/ })).toBeVisible();
  });

  await test.step("texto da nota fiscal e do boleto (campo inválido recusado)", async () => {
    await page.getByRole("tab", { name: "Nota fiscal e boleto" }).click();
    await page.getByLabel("Texto da nota fiscal").fill("Serviço {{senha}}");
    await page.getByRole("button", { name: "Salvar textos" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Campo desconhecido" })).toBeVisible();
    await page.getByLabel("Texto da nota fiscal").fill("Serviços de monitoramento — competência {{competencia}}");
    await page.getByLabel("Texto do boleto").fill("Não receber após 10 dias do vencimento.");
    await page.getByRole("button", { name: "Salvar textos" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Salvo: .*texto da nota fiscal/ })).toBeVisible();
  });

  await test.step("anotações e contatos nas abas; recarregar mantém o que foi salvo", async () => {
    await page.getByRole("tab", { name: /^Anotações/ }).click();
    await page.getByLabel("Novo comentário").fill("Cliente pediu NF separada do boleto.");
    await page.getByRole("button", { name: "Adicionar comentário" }).click();
    await expect(page.getByRole("tab", { name: /^Anotações \(1\)/ })).toBeVisible();
    await expect(page.getByText("Cliente pediu NF separada do boleto.")).toBeVisible();
    await page.getByRole("tab", { name: /^Contatos/ }).click();
    await expect(page.getByText(/Nenhum contato/)).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "Endereço" }).click();
    await expect(page.getByLabel("Logradouro")).toHaveValue("Av. Exemplo");
    await expect(page.getByLabel("UF")).toHaveValue("AM");
  });
});

test("Configurações no menu: entra em Empresa (dados, endereço, contador) e tem as abas de Usuários e Registro", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configurações" }).click();
  await expect(page).toHaveURL(/\/empresa$/);
  await expect(page.getByRole("heading", { name: "Dados da empresa" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Configurações" });
  await expect(tabs.getByRole("link", { name: "Empresa" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Configurações" })).toHaveAttribute("aria-current", "page");
  for (const legend of ["Contabilidade (contador ou escritório)", "Endereço da empresa", "Dados fiscais para a nota (NFS-e)"]) await expect(page.getByText(legend)).toBeVisible();
  await tabs.getByRole("link", { name: "Usuários e acessos" }).click();
  await expect(page).toHaveURL(/\/configuracao\?aba=usuarios$/);
  await expect(page.getByRole("heading", { name: "Usuários e acessos" })).toBeVisible();
  await tabs.getByRole("link", { name: "Registro de atividades" }).click();
  await expect(page).toHaveURL(/\/auditoria$/);
  await expect(page.getByRole("heading", { name: "Registro de atividades" })).toBeVisible();
});
