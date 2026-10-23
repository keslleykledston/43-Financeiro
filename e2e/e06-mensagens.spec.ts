import { test, expect } from "@playwright/test";

test("E06 — modelos: criar padrão, rascunho com prévia fictícia, HTML barrado, ativar; fila em simulação", async ({ page }) => {
  await test.step("modelos padrão", async () => {
    await page.goto("/mensagens/modelos");
    await expect(page.getByRole("heading", { name: "Modelos de mensagem" })).toBeVisible();
    const criar = page.getByRole("button", { name: /Criar modelos padrão/ });
    if (await criar.count()) await criar.click();
    await expect(page.getByRole("button", { name: /Criar modelos padrão/ })).toHaveCount(0);
    await expect(page.getByText("Versão 1 ativa").first()).toBeVisible();
    await expect(page.getByText("Revisão humana D+15")).toHaveCount(0); // revisão é tarefa interna, não tem modelo
  });

  const url = "/mensagens/modelos/d0/email";
  await test.step("HTML e campo desconhecido são recusados", async () => {
    await page.goto(url);
    await page.getByLabel("Mensagem").fill("Olá <script>alert(1)</script>");
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(page.getByText(/Use apenas texto simples|Campo desconhecido/)).toContainText("HTML não é permitido");
    await page.getByLabel("Mensagem").fill("Olá {{senha}}");
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(page.getByText(/Use apenas texto simples|Campo desconhecido/)).toContainText("Campo desconhecido");
  });

  await test.step("rascunho mostra prévia com dados fictícios e só vale ao ativar", async () => {
    await page.goto(url);
    await page.getByLabel("Assunto").fill("Vence {{vencimento}} — teste E06");
    await page.getByLabel("Mensagem").fill("Olá, {{cliente}}! Valor {{valor}} (E06).");
    await page.getByRole("button", { name: "Salvar rascunho" }).click();
    await expect(page.getByText("Rascunho salvo")).toBeVisible();
    await expect(page.getByTestId("preview")).toHaveText("Olá, Cliente Exemplo Ltda! Valor R$ 2.500,00 (E06).");
    await expect(page.getByText("Vence 14/11/2026 — teste E06")).toBeVisible();
    await page.getByRole("button", { name: "Ativar" }).click();
    await expect(page.getByText("Versão ativada")).toBeVisible();
    await expect(page.getByRole("button", { name: "Ativar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restaurar esta versão" }).first()).toBeVisible();
  });

  await test.step("fila: aviso de simulação, programar e processar não enviam nada", async () => {
    await page.goto("/mensagens");
    await expect(page.getByRole("heading", { name: "Mensagens" })).toBeVisible();
    await expect(page.getByText("Nenhum e-mail ou WhatsApp sai do sistema")).toBeVisible();
    await page.getByRole("button", { name: "Programar mensagens" }).click();
    await expect(page.getByText(/Fila programada:/)).toBeVisible();
    await page.getByRole("button", { name: /Processar vencidos/ }).click();
    await expect(page.getByText(/Simulação concluída:.*Nada foi enviado/)).toBeVisible();
  });
});
