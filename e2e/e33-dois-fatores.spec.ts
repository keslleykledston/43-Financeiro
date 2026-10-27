import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { aceitarConvite } from "./helpers";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const dec = (s: string) => { let bits = 0, v = 0; const o: number[] = []; for (const ch of s.replace(/\s/g, "").toUpperCase()) { v = (v << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(o); };
const code = (secret: string, shift = 0) => { const c = Math.floor(Date.now() / 30000) + shift; const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(c)); const h = createHmac("sha1", dec(secret)).update(m).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0"); };
const SENHA = "Dois-Fatores-Senha-321";

// Usa um usuário convidado (nunca o admin compartilhado do auth.setup).
test("E28 — ativar o 2FA, entrar pedindo o código, recusar código errado/reusado e desligar", async ({ page, browser }) => {
  const email = `tf-${Date.now()}@sandbox.test`;
  await page.goto("/configuracao?aba=usuarios");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Papel").selectOption({ label: "Gerente" });
  await page.getByRole("button", { name: "Convidar" }).click();
  const link = page.getByRole("status").filter({ hasText: "Convite criado" }).locator("code");
  const path = new URL((await link.innerText()).trim()).pathname;
  const guest = await aceitarConvite(browser, path, "Usuário Dois Fatores", SENHA);
  const u = guest.page;

  await u.goto("/conta");
  await expect(u.getByRole("heading", { name: "Verificação em duas etapas" })).toBeVisible();
  await u.getByLabel("Confirme com a sua senha para começar").fill(SENHA);
  await u.getByRole("button", { name: "Ativar verificação em duas etapas" }).click();
  const secret = (await u.getByLabel("Chave do aplicativo").innerText()).trim();
  await u.getByLabel("Código do aplicativo").fill("000000");
  await u.getByRole("button", { name: "Confirmar e ativar" }).click();
  await expect(u.locator("p[role=alert]")).toContainText("Código incorreto");
  await u.getByLabel("Código do aplicativo").fill(code(secret));
  await u.getByRole("button", { name: "Confirmar e ativar" }).click();
  await expect(u.getByText("Verificação em duas etapas ativada.")).toBeVisible();
  await expect(u.getByLabel("Códigos de recuperação").locator("li")).toHaveCount(10);
  const recovery = (await u.getByLabel("Códigos de recuperação").locator("li").first().innerText()).trim();
  await guest.ctx.close();

  // novo login: senha certa → pede o código
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const l = await ctx.newPage();
  await l.goto("/login");
  await l.getByLabel("E-mail").fill(email);
  await l.getByLabel("Senha").fill("senha-errada-000000");
  await l.getByRole("button", { name: "Entrar" }).click();
  await expect(l.getByText("E-mail ou senha inválidos.")).toBeVisible();
  await expect(l.getByLabel("Código de verificação")).toHaveCount(0); // senha errada nunca revela o 2FA
  await l.getByLabel("Senha").fill(SENHA);
  await l.getByRole("button", { name: "Entrar" }).click();
  await expect(l.getByLabel("Código de verificação")).toBeVisible();
  await l.getByLabel("Código de verificação").fill("111111");
  await l.getByRole("button", { name: "Verificar e entrar" }).click();
  await expect(l.getByText(/Código incorreto ou já usado/)).toBeVisible();
  await l.getByLabel("Código de verificação").fill(recovery); // código de recuperação serve (uma vez)
  await l.getByRole("button", { name: "Verificar e entrar" }).click();
  await expect(l.getByRole("heading", { name: "Visão executiva" })).toBeVisible();

  // desligar (senha + código do aplicativo no passo seguinte: o do cadastro já foi usado)
  await l.goto("/conta");
  await l.getByLabel("Senha atual para desligar").fill(SENHA);
  await l.getByLabel("Código para desligar").fill(code(secret, 1));
  await l.getByRole("button", { name: "Desligar", exact: true }).click();
  await expect(l.getByText("Verificação em duas etapas desligada.")).toBeVisible();
  await ctx.close();
});
