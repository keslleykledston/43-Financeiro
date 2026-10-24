import { test, expect } from "@playwright/test";

test("Registro de atividades — diretoria vê eventos, filtra por tipo e some o que não bate", async ({ page }) => {
  await page.goto("/configuracao?aba=usuarios");
  await page.getByRole("link", { name: "Registro de atividades" }).click();
  await expect(page.getByRole("heading", { name: "Registro de atividades" })).toBeVisible();
  // outros specs geram muitas atividades (a 1ª página pode não ter logins): o login do admin do sandbox está registrado, então filtra por ele
  await page.getByLabel("Tipo de ação (começa com)").fill("auth.login");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page.getByRole("list", { name: "Atividades" }).getByText("Entrou no sistema").first()).toBeVisible();
  await page.getByLabel("Tipo de ação (começa com)").fill("nao.existe");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(page.getByText("Nenhuma atividade neste filtro")).toBeVisible();
  // data inválida na URL não derruba a tela
  await page.goto("/auditoria?de=ontem&p=abc");
  await expect(page.getByRole("heading", { name: "Registro de atividades" })).toBeVisible();
});
