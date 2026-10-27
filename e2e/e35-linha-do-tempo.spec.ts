import { test, expect } from "@playwright/test";

test("H2 — linha do tempo dos clientes: abre pelo histórico, avisa que é inferência e não altera nada", async ({ page }) => {
  await page.goto("/historico");
  await page.getByRole("link", { name: "Linha do tempo dos clientes" }).click();
  await expect(page.getByRole("heading", { name: "Linha do tempo dos clientes", level: 1 })).toBeVisible();
  await expect(page.getByText(/Não cria nem altera contrato, aditivo, cobrança ou pagamento/)).toBeVisible();
  // sem histórico importado na stack de teste: estado vazio; com histórico: resumo e ponte
  await expect(page.getByText("Sem histórico importado").or(page.getByLabel("Resumo"))).toBeVisible();
  const r = await page.request.get("/historico/linha-do-tempo/exportar");
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("text/csv");
});
