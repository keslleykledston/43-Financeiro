import { test, expect } from "@playwright/test";

test.describe("Design system e tema", () => {
  test("claro por padrão; alternar para escuro persiste entre páginas e recarga", async ({ page }) => {
    await page.goto("/");
    const html = page.locator("html");
    await expect(html).not.toHaveClass(/dark/);
    await page.getByRole("button", { name: "Usar tema escuro" }).click();
    await expect(html).toHaveClass(/dark/);
    await page.goto("/clientes");
    await expect(html).toHaveClass(/dark/);           // persistido
    await page.reload();
    await expect(html).toHaveClass(/dark/);           // sem piscar para o claro
    await page.getByRole("button", { name: "Usar tema claro" }).click();
    await expect(html).not.toHaveClass(/dark/);
  });

  test("/design-system lista tokens e componentes nos dois temas", async ({ page }) => {
    await page.goto("/design-system");
    await expect(page.getByRole("heading", { name: "Design system", level: 1 })).toBeVisible();
    for (const t of ["Cores (tokens semânticos)", "Tipografia", "Semânticas (sempre ícone + texto)", "Botões e campos", "Avisos", "Estados de tela"]) {
      await expect(page.getByRole("heading", { name: t })).toBeVisible();
    }
    await page.getByRole("button", { name: "Usar tema escuro" }).click();
    await expect(page.getByRole("heading", { name: "Avisos" })).toBeVisible();
  });

  test("fontes do design (Space Grotesk / IBM Plex) são servidas pelo próprio app (sem CDN)", async ({ page }) => {
    const hosts = new Set<string>();
    page.on("request", (r) => hosts.add(new URL(r.url()).host));
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    expect([...hosts].filter((h) => !h.startsWith("sandbox-web") && !h.startsWith("127.0.0.1") && !h.startsWith("localhost"))).toEqual([]);
    const fams = await page.evaluate(() => [...document.fonts].map((f) => f.family.replace(/"/g, "")));
    expect(fams.join("|")).toMatch(/IBM Plex Sans/);
  });
});
