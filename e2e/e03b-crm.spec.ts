import { test, expect, type Page } from "@playwright/test";

const CRM = process.env.FAKE_CRM_URL ?? "http://sandbox-crm:4000";
const setCrm = async (page: Page, body: object) => { const r = await page.request.post(`${CRM}/__set`, { data: body }); expect(r.ok()).toBe(true); };
const dv = (b: string, w: number[]) => { const r = [...b].reduce((s, c, i) => s + +c * w[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
const cnpj = (n: number) => { const base = `${String(70000000 + n).padStart(8, "0")}0001`; const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); return base + d1 + dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); };
const run = Date.now() % 1000;
const A = cnpj(run * 10 + 1), B = cnpj(run * 10 + 2), C = cnpj(run * 10 + 3), D = cnpj(run * 10 + 4);
// formato REAL do K3G CRM: só ACTIVE é cliente; PROSPECT/CHURNED/INACTIVE não
const crmItem = (id: string, razaoSocial: string, cnpj: string, extra: object = {}) => ({ id, name: razaoSocial, razaoSocial, cnpj, email: null, phone: null, crmStatus: "ACTIVE", isActive: true, ...extra });
const alerta = (p: Page) => p.locator("p[role=alert]");

test("E03b — CRM: ativar, prévia sem gravar, aplicar, idempotência, somente leitura, conflito, alteração/arquivamento e falha", async ({ page }) => {
  await test.step("padrão LOCAL: sincronizar nem aparece e dá para cadastrar cliente", async () => {
    await setCrm(page, { items: [], failStatus: 0, pageSize: 2 });
    await page.goto("/integracoes");
    await expect(page.getByText("Atual:")).toContainText("Local");
    await expect(page.getByRole("button", { name: "Revisar sincronização" })).toHaveCount(0);
    await expect(page.getByRole("note")).toContainText("modo Local");
    await page.goto("/clientes/novo");
    await expect(page.getByLabel("Tipo").locator("option")).toHaveText(["Cliente", "Fornecedor"]);
  });

  // cadastro manual (modo local) que vai conflitar com o CRM depois (mesmo documento)
  await page.goto("/clientes/novo");
  await page.getByLabel("Razão social / nome").fill("Manual Conflito Ltda");
  await page.getByLabel("CPF ou CNPJ").fill(C);
  await page.getByRole("button", { name: "Cadastrar" }).click();
  await expect(page.getByRole("heading", { name: "Manual Conflito Ltda" })).toBeVisible();

  await test.step("trocar a origem para CRM: banner na lista; novo cadastro só permite fornecedor", async () => {
    await page.goto("/integracoes");
    await page.getByLabel(/^CRM/).check();
    await page.getByRole("button", { name: "Salvar origem dos clientes" }).click();
    await expect(page.getByText("Origem dos clientes salva.")).toBeVisible();
    await expect(page.getByText("Atual:")).toContainText("CRM");
    await page.goto("/clientes");
    await expect(page.getByRole("note")).toContainText("vêm do CRM");
    await page.goto("/clientes/novo");
    await expect(page.getByLabel("Tipo").locator("option")).toHaveText(["Fornecedor"]);
    await expect(page.getByRole("note")).toContainText("apenas fornecedores");
  });

  await test.step("conexão desativada: o botão de revisar é recusado; depois ativar", async () => {
    await page.goto("/integracoes");
    await expect(page.getByText("Chave geral do servidor:")).toContainText("ligada");
    await expect(page.getByText("Nesta empresa:")).toContainText("desativada");
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    await expect(alerta(page)).toContainText("não está ativada");
    await page.getByLabel(/Ativar sincronização/).check();
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();
  });

  await setCrm(page, { items: [
    crmItem("x1", "Rede Alfa CRM", A, { email: "ana@alfa.test" }),
    crmItem("x2", "Rede Beta CRM", B),
    crmItem("x3", "Nome do CRM Conflito", C),
    crmItem("x4", "Prospecto Delta", D, { crmStatus: "PROSPECT" }), // prospect nunca é cliente
  ] });

  await test.step("prévia mostra o plano e NÃO grava (paginação de 2 em 2 incluída)", async () => {
    await page.goto("/integracoes");
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    const resumo = page.getByRole("status").filter({ hasText: "novos" });
    await expect(resumo).toContainText("2 novos");
    await expect(resumo).toContainText("1 conflitos");
    await expect(resumo).toContainText("1 ignorados"); // o PROSPECT
    await expect(page.getByText("＋ Rede Alfa CRM")).toBeVisible();
    await page.goto("/clientes?q=Rede+Alfa");
    await expect(page.getByText("Nada encontrado para essa busca.")).toBeVisible();
  });

  await test.step("aplicar cria, com selo CRM, e o cadastro fica somente leitura", async () => {
    await page.goto("/integracoes");
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    await page.getByRole("button", { name: "Confirmar e aplicar" }).click();
    await expect(page.getByText(/Sincronização concluída: 2 criados/)).toBeVisible();
    await page.goto("/clientes?q=Rede+Alfa");
    const link = page.getByRole("link", { name: /Rede Alfa CRM/ });
    await expect(link).toContainText("CRM");
    await link.click();
    await expect(page.getByRole("note")).toContainText("somente leitura");
    await expect(page.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Arquivar cadastro" })).toHaveCount(0);
    await expect(page.locator("li", { hasText: "Cadastro no CRM" })).toContainText("ana@alfa.test");
  });

  await test.step("idempotência: repetir não cria nada", async () => {
    await page.goto("/integracoes");
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    await expect(page.getByRole("status").filter({ hasText: "novos" })).toContainText("0 novos");
    await page.getByRole("button", { name: "Confirmar e aplicar" }).click();
    await expect(page.getByText(/Sincronização concluída: 0 criados, 0 alterados/)).toBeVisible();
  });

  await test.step("conflito: fica na fila, vincular adota o cadastro local", async () => {
    await page.goto("/integracoes");
    const li = page.locator("li", { hasText: "Nome do CRM Conflito" });
    await expect(li).toContainText("Já existe um cadastro local");
    await li.getByRole("button", { name: "Vincular ao cadastro existente" }).click();
    await expect(page.locator("li", { hasText: "Nome do CRM Conflito" })).toHaveCount(0);
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    await page.getByRole("button", { name: "Confirmar e aplicar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sincronização concluída" })).toContainText("1 alterados");
    await page.goto("/clientes?q=Nome+do+CRM+Conflito");
    await expect(page.getByRole("link", { name: /Nome do CRM Conflito/ })).toContainText("CRM");
  });

  await test.step("alteração e inativação no CRM: renomeia e arquiva (sem apagar)", async () => {
    await setCrm(page, { items: [
      crmItem("x1", "Rede Alfa Renomeada", A, { email: "ana@alfa.test" }), crmItem("x2", "Rede Beta CRM", B, { crmStatus: "CHURNED" }), crmItem("x3", "Nome do CRM Conflito", C),
    ] });
    await page.goto("/integracoes");
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    const resumo = page.getByRole("status").filter({ hasText: "novos" });
    await expect(resumo).toContainText("1 alterados");
    await expect(resumo).toContainText("1 a arquivar");
    await page.getByRole("button", { name: "Confirmar e aplicar" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Sincronização concluída" })).toContainText("1 arquivados");
    await page.goto("/clientes?q=Rede");
    await expect(page.getByRole("link", { name: /Rede Alfa Renomeada/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Rede Beta CRM/ })).toHaveCount(0);
    await page.goto("/clientes?q=Rede+Beta&arq=1");
    await expect(page.getByRole("link", { name: /Rede Beta CRM/ })).toBeVisible();
  });

  await test.step("falha do CRM (503): erro claro, nada muda e o app continua de pé", async () => {
    await setCrm(page, { failStatus: 503 });
    await page.goto("/integracoes");
    await page.getByRole("button", { name: "Revisar sincronização" }).click();
    await expect(alerta(page)).toContainText(/503|tentativas/, { timeout: 20_000 });
    const r = await page.goto("/clientes");
    expect(r?.status()).toBe(200);
    await setCrm(page, { failStatus: 0 }); // restaura o CRM falso para os demais testes
  });

  await test.step("voltar para LOCAL libera a edição do cadastro importado; CRM bloqueia de novo", async () => {
    await page.goto("/integracoes");
    await page.getByLabel(/^Local/).check();
    await page.getByRole("button", { name: "Salvar origem dos clientes" }).click();
    await expect(page.getByText("Atual:")).toContainText("Local");
    await page.goto("/clientes?q=Rede+Alfa+Renomeada");
    await page.getByRole("link", { name: /Rede Alfa Renomeada/ }).click();
    await expect(page.getByRole("button", { name: "Salvar" })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("modo Local");
    await page.goto("/integracoes");
    await page.getByLabel(/^CRM/).check();
    await page.getByRole("button", { name: "Salvar origem dos clientes" }).click();
    await expect(page.getByText("Atual:")).toContainText("CRM");
    await page.goto("/clientes?q=Rede+Alfa+Renomeada");
    await page.getByRole("link", { name: /Rede Alfa Renomeada/ }).click();
    await expect(page.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    // deixa o sandbox no padrão
    await page.goto("/integracoes");
    await page.getByLabel(/^Local/).check();
    await page.getByRole("button", { name: "Salvar origem dos clientes" }).click();
    await expect(page.getByText("Atual:")).toContainText("Local");
  });
});
