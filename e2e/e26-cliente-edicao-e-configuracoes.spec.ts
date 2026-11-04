import { test, expect } from "@playwright/test";

const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(50000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 100000;
const NOME = `Cliente Edicao ${run}`;

test("Cliente: ver tudo na aba Dados, botão Editar, nome aparente, o que o cliente recebe, endereço, textos, anotações e contatos", async ({ page }) => {
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill(NOME);
  await page.getByLabel("CPF ou CNPJ").fill(cnpj(run));
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cadastro" })).toBeVisible();
  for (const t of ["Dados", "Nota fiscal e boleto", /^Anotações/]) await expect(page.getByRole("tab", { name: t })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Endereço" })).toHaveCount(0); // endereço e contatos agora ficam na aba Dados
  await expect(page.getByRole("tab", { name: /^Contatos/ })).toHaveCount(0);
  for (const sec of ["Identificação", "Nome aparente e emissão", "Endereço", /^Contatos \(0\)/]) await expect(page.getByRole("heading", { name: sec })).toBeVisible();
  await expect(page.getByText("Emite boleto").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Salvar/ })).toHaveCount(0); // leitura: nada de formulário até clicar em Editar

  await test.step("Editar: dados com validador de CNPJ", async () => {
    await page.getByRole("link", { name: "Editar", exact: true }).click();
    await expect(page.getByRole("link", { name: "Concluir edição" })).toBeVisible();
    await page.getByLabel("CPF ou CNPJ").fill("22.991.939/0001-60");
    await expect(page.getByText(/dígitos verificadores do CNPJ não conferem/)).toBeVisible();
    await page.getByRole("button", { name: "22.991.939/0001-06" }).click();
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Alterações salvas.")).toBeVisible();
    await expect(page.getByText("CNPJ 22.991.939/0001-06").first()).toBeVisible();
  });

  await test.step("nome aparente (vale no título e na busca) e boleto/nota fiscal", async () => {
    await page.getByRole("link", { name: "Editar", exact: true }).click();
    await page.getByLabel("Nome aparente", { exact: true }).fill(`Mercadinho ${run}`);
    await page.getByLabel("Emite boleto").uncheck();
    await page.getByLabel("Emite nota fiscal").check();
    await page.getByRole("button", { name: "Salvar nome e emissão" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Salvo: .*nome aparente.*emite boleto.*emite nota fiscal/ })).toBeVisible();
    await page.getByRole("link", { name: "Concluir edição" }).click();
    await expect(page.getByRole("heading", { name: `Mercadinho ${run}` })).toBeVisible();
    await expect(page.getByText(`razão social: ${NOME}`)).toBeVisible();
    await page.goto(`/clientes?q=${encodeURIComponent(`Mercadinho ${run}`)}`);
    const li = page.getByRole("link", { name: new RegExp(`Mercadinho ${run}`) });
    await expect(li).toContainText("Sem boleto");
    await expect(li).toContainText("Com NF");
    await li.click();
  });

  await test.step("endereço", async () => {
    await page.getByRole("link", { name: "Editar", exact: true }).click();
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

  await test.step("contato na mesma aba", async () => {
    await page.getByLabel("Nome do contato").fill("Maria Financeiro");
    await page.getByLabel("E-mail do contato").fill("maria@exemplo.test");
    await page.getByLabel(/Contato financeiro/).check();
    await page.getByRole("button", { name: "Adicionar contato" }).click();
    await expect(page.locator("li", { hasText: "Maria Financeiro" })).toContainText("Financeiro");
    await expect(page.getByRole("heading", { name: /^Contatos \(1\)/ })).toBeVisible();
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

  await test.step("anotações; recarregar mantém o que foi salvo", async () => {
    await page.getByRole("tab", { name: /^Anotações/ }).click();
    await page.getByLabel("Novo comentário").fill("Cliente pediu NF separada do boleto.");
    await page.getByRole("button", { name: "Adicionar comentário" }).click();
    await expect(page.getByRole("tab", { name: /^Anotações \(1\)/ })).toBeVisible();
    await expect(page.getByText("Cliente pediu NF separada do boleto.")).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "Dados" }).click();
    await expect(page.getByText("Av. Exemplo")).toBeVisible();
    await expect(page.getByText("Emite boleto").locator("..")).toContainText("Não");
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
