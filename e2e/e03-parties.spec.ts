import { test, expect, type Page } from "@playwright/test";

const CNPJ_ALFA = "12.ABC.345/01DE-35";
const alerta = (p: Page) => p.locator("p[role=alert]");

async function cadastrar(page: Page, nome: string, doc: string, tipo = "Cliente") {
  await page.goto("/clientes/novo");
  await page.getByLabel("Tipo").selectOption({ label: tipo });
  await page.getByLabel("Razão social / nome").fill(nome);
  await page.getByLabel("CPF ou CNPJ").fill(doc);
  await page.getByRole("button", { name: "Cadastrar" }).click();
}

test("E03 — cadastro, validação, duplicidade, contatos, histórico, busca, arquivar, importar, exportar e isolamento", async ({ page }) => {
  await test.step("estado vazio útil", async () => {
    await page.goto("/clientes");
    await expect(page.getByText("Nenhum cadastro ainda.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Importar CSV" })).toBeVisible();
  });

  await test.step("CNPJ inválido é recusado e o formulário mantém o que foi digitado", async () => {
    await cadastrar(page, "Acme Telecom Ltda", "11.222.333/0001-80");
    await expect(alerta(page)).toHaveText("CPF ou CNPJ inválido");
    await expect(page.getByLabel("Razão social / nome")).toHaveValue("Acme Telecom Ltda");
  });

  await test.step("CNPJ alfanumérico válido cria e abre o detalhe", async () => {
    await page.getByLabel("CPF ou CNPJ").fill(CNPJ_ALFA);
    await page.getByRole("button", { name: "Cadastrar" }).click();
    await expect(page.getByRole("heading", { name: "Acme Telecom Ltda" })).toBeVisible();
    await expect(page.getByText(`CNPJ ${CNPJ_ALFA}`)).toBeVisible();
  });
  const detalhe = page.url();

  await test.step("documento duplicado na mesma empresa é recusado", async () => {
    await cadastrar(page, "Outra Razão", "12abc34501de35");
    await expect(alerta(page)).toContainText("Já existe um cadastro ativo");
  });

  await test.step("editar, contato financeiro e histórico", async () => {
    await page.goto(detalhe);
    await page.getByLabel("Nome fantasia (opcional)").fill("Acme");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Alterações salvas.")).toBeVisible();
    await page.getByRole("tab", { name: /^Contatos/ }).click();
    await page.getByLabel("Nome do contato").fill("Maria Financeiro");
    await page.getByLabel("E-mail do contato").fill("maria@acme.test");
    await page.getByLabel(/Contato financeiro/).check();
    await page.getByRole("button", { name: "Adicionar contato" }).click();
    const li = page.locator("li", { hasText: "Maria Financeiro" });
    await expect(li).toContainText("Financeiro");
    await expect(li).toContainText("maria@acme.test");
    await expect(page.getByText("Cadastro criado")).toBeVisible();
    await expect(page.getByText("Dados alterados")).toBeVisible();
    await expect(page.getByText("Contato adicionado")).toBeVisible();
    await li.getByRole("button", { name: "Remover" }).click();
    await expect(page.locator("li", { hasText: "Maria Financeiro" })).toHaveCount(0);
  });

  await test.step("busca por nome e documento, filtro por tipo", async () => {
    await page.goto("/clientes");
    await page.getByLabel("Buscar").fill("acme");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByRole("link", { name: /Acme Telecom/ })).toBeVisible();
    await page.getByLabel("Buscar").fill("12.ABC.345");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByRole("link", { name: /Acme Telecom/ })).toBeVisible();
    await page.getByLabel("Buscar").fill("inexistente-xyz");
    await page.getByRole("button", { name: "Buscar" }).click();
    await expect(page.getByText("Nada encontrado para essa busca.")).toBeVisible();
    await page.goto("/clientes?tipo=fornecedor");
    await expect(page.getByText("Nenhum cadastro ainda.")).toBeVisible();
  });

  await test.step("arquivar some da lista ativa, aparece em arquivados e restaura", async () => {
    await page.goto(detalhe);
    await page.getByRole("button", { name: "Arquivar cadastro" }).click();
    await expect(page).toHaveURL(/\/clientes$/);
    await expect(page.getByText("Nenhum cadastro ainda.")).toBeVisible();
    await page.getByRole("link", { name: "Ver arquivados" }).click();
    await page.getByRole("link", { name: /Acme Telecom/ }).click();
    await expect(page.getByText("Arquivado", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restaurar cadastro" }).click();
    await expect(page.getByRole("heading", { name: "Acme Telecom Ltda" })).toBeVisible();
    await expect(page.getByText("Arquivado", { exact: true })).toHaveCount(0);
  });

  await test.step("importação: prévia não grava; confirma só as válidas", async () => {
    await page.goto("/clientes/importar");
    const csv = ["tipo;razao_social;nome_fantasia;documento;email_financeiro;telefone",
      "cliente;Beta Redes;;11.222.333/0001-81;fin@beta.test;", "fornecedor;Gama Fornecedor;;529.982.247-25;;", "cliente;Sem Doc Valido;;123;;"].join("\n");
    await page.getByLabel("ou cole o conteúdo").fill(csv);
    await page.getByRole("button", { name: /Revisar/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "válidas" })).toContainText("2 válidas");
    await expect(page.getByText("CPF ou CNPJ inválido")).toBeVisible();
    await page.goto("/clientes");
    await expect(page.getByRole("link", { name: /Beta Redes/ })).toHaveCount(0); // prévia não gravou
    await page.goto("/clientes/importar");
    await page.getByLabel("ou cole o conteúdo").fill(csv);
    await page.getByRole("button", { name: /Revisar/ }).click();
    await page.getByRole("button", { name: /Confirmar importação de 2/ }).click();
    await expect(page.getByText("Importação concluída: 2 cadastro(s) criados, 1 ignorados.")).toBeVisible();
    await page.goto("/clientes");
    await expect(page.getByRole("link", { name: /Beta Redes/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Gama Fornecedor/ })).toBeVisible();
  });

  await test.step("exportação CSV neutraliza fórmulas", async () => {
    await cadastrar(page, "=cmd|' /C calc'!A0", "52998224725");
    await expect(page.getByRole("heading")).toBeVisible();
    const r = await page.request.get("/clientes/exportar");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("text/csv");
    const body = await r.text();
    expect(body).toContain("Acme Telecom Ltda");
    expect(body).toContain("'=cmd");
    expect(body).not.toMatch(/(^|;)=cmd/m);
  });

  await test.step("isolamento: outra empresa não vê nem abre o cadastro da primeira", async () => {
    await page.goto("/");
    await page.getByLabel("Empresa").selectOption({ label: "K3G Call" });
    await page.getByRole("button", { name: "Trocar" }).click();
    await expect(page.getByText("K3G Call · ")).toBeVisible(); // espera a troca concluir antes de navegar
    await page.goto("/clientes");
    await expect(page.getByText(/^K3G Call · /)).toBeVisible();
    await expect(page.getByText("Nenhum cadastro ainda.")).toBeVisible();
    const resp = await page.goto(detalhe);
    expect(resp?.status()).toBe(404);
    const ex = await page.request.get("/clientes/exportar");
    expect(await ex.text()).not.toContain("Acme Telecom");
  });
});

test("E03 — contabilidade vê e exporta, mas não cadastra", async ({ page, browser }) => {
  const email = `contab-${Date.now()}@sandbox.test`, senha = "Contab-Senha-789!";
  await page.goto("/configuracao?aba=usuarios");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: "Contabilidade" });
  await page.getByRole("button", { name: "Convidar" }).click();
  const code = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  await expect(code).toBeVisible();
  const path = new URL((await code.innerText()).trim()).pathname;

  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const g = await ctx.newPage();
  await g.goto(path);
  await g.getByLabel("E-mail convidado").fill(email);
  await g.getByLabel("Nome").fill("Contabilidade");
  await g.getByLabel(/^Senha/).fill(senha);
  await g.getByRole("button", { name: "Criar acesso" }).click();
  await expect(g).toHaveURL(/\/login/);
  await g.getByLabel("E-mail").fill(email);
  await g.getByLabel("Senha").fill(senha);
  await g.getByRole("button", { name: "Entrar" }).click();
  await expect(g.getByRole("heading", { name: "Visão executiva" })).toBeVisible();

  await g.goto("/clientes");
  await expect(g.getByRole("heading", { name: "Clientes e fornecedores" })).toBeVisible();
  await expect(g.getByRole("link", { name: "Exportar CSV" })).toBeVisible();
  await expect(g.getByRole("link", { name: "Novo", exact: true })).toHaveCount(0);
  await expect(g.getByRole("link", { name: "Importar CSV" })).toHaveCount(0);
  await g.goto("/clientes/novo");
  await expect(g.getByText("Seu papel não permite cadastrar.")).toBeVisible();
  expect((await g.request.get("/clientes/exportar")).status()).toBe(200);
  await ctx.close();
});
