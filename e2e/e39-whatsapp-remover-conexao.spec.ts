import { test, expect } from "@playwright/test";

const WAHA = process.env.FAKE_WAHA_URL ?? "http://waha:3000";
const KEY = process.env.FAKE_WAHA_KEY ?? "sandbox-waha-key";
const H = { "X-Api-Key": KEY };

// roda ANTES dos demais e2e de WhatsApp (e40–e44): a empresa tem no máximo 3 conexões e este teste cria e remove a sua, sem sobrar nada
test("WhatsApp — remover conexão: só aparece fora de «Conectada», exige confirmação, apaga na WAHA, some da lista e libera a vaga", async ({ page, request }) => {
  await page.goto("/whatsapp");
  const before = (await (await request.get(`${WAHA}/api/sessions`, { headers: H })).json()).length;

  await test.step("cria uma conexão extra (aguardando QR): o botão Remover conexão aparece", async () => {
    await page.getByLabel("Nome interno da conexão").fill("Conexão descartável e2e");
    await page.getByLabel(/Confirmo que tenho autorização/).check();
    await page.getByRole("button", { name: "Conectar WhatsApp" }).click();
    await expect(page.getByText("Conexão criada")).toBeVisible();
    await page.goto("/whatsapp");
    const card = page.locator("section", { hasText: "Conexão descartável e2e" }).first();
    await expect(card.getByRole("button", { name: "Remover conexão" })).toBeVisible();
    expect((await (await request.get(`${WAHA}/api/sessions`, { headers: H })).json()).length).toBe(before + 1);
  });

  await test.step("sem confirmar, o navegador barra; confirmando, a conexão é removida e some da lista", async () => {
    const card = page.locator("section", { hasText: "Conexão descartável e2e" }).first();
    await card.getByRole("button", { name: "Remover conexão" }).click(); // sem «Confirmo»: required
    await expect(page.getByText("Conexão removida")).toHaveCount(0);
    await card.getByRole("checkbox", { name: "Confirmo" }).last().check();
    await card.getByRole("button", { name: "Remover conexão" }).click();
    await expect(page.getByText("Conexão removida. O histórico foi mantido.")).toBeVisible();
    await page.goto("/whatsapp");
    await expect(page.getByText("Conexão descartável e2e")).toHaveCount(0);
    expect((await (await request.get(`${WAHA}/api/sessions`, { headers: H })).json()).length).toBe(before);
  });
});
