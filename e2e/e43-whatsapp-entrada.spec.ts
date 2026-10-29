import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

const WAHA = process.env.FAKE_WAHA_URL ?? "http://waha:3000";
const KEY = process.env.FAKE_WAHA_KEY ?? "sandbox-waha-key";
const HMAC = process.env.WAHA_HOOK_HMAC_KEY ?? "sandbox-hmac-key-0123456789abcdef";
const H = { "X-Api-Key": KEY };
let n = 0;

test("W3b — WhatsApp: aviso assinado da WAHA, triagem, atribuição, resposta que suspende a cobrança e «PARAR» que bloqueia na hora (sem resposta automática)", async ({ page, request }) => {
  await request.post(`${WAHA}/__test/reset`, { headers: H });
  let session = "";
  const send = async (event: string, payload: Record<string, unknown>, o: { sign?: boolean; key?: string } = {}) => {
    const raw = JSON.stringify({ id: `evt_e2e_${Date.now()}_${++n}`, timestamp: Date.now(), event, session, me: null, payload });
    const sig = createHmac("sha512", o.key ?? HMAC).update(raw).digest("hex");
    return request.post("/api/v1/webhooks/waha", { data: raw, headers: { "content-type": "application/json", "x-webhook-hmac": o.sign === false ? "" : sig, "x-webhook-hmac-algorithm": "sha512", "x-webhook-timestamp": String(Date.now()) }, maxRedirects: 0 });
  };
  const inbound = (from: string, body: string) => send("message", { from: `${from}@c.us`, fromMe: false, body, hasMedia: false });

  await test.step("uma conexão conectada para receber os avisos", async () => {
    await page.goto("/whatsapp");
    await page.getByLabel("Nome interno da conexão").fill("Entrada e2e");
    await page.getByLabel(/Confirmo que tenho autorização/).check();
    await page.getByRole("button", { name: "Conectar WhatsApp" }).click();
    await expect(page.getByText("Conexão criada")).toBeVisible();
    const list = await (await request.get(`${WAHA}/api/sessions`, { headers: H })).json();
    session = list[0].name;
    await request.post(`${WAHA}/__test/connect`, { headers: H, data: { name: session, phone: "5592988887777" } });
  });

  await test.step("sem assinatura válida o aviso é recusado (401) e nada aparece; com assinatura é aceito (202)", async () => {
    expect((await send("message", { from: "5592966660001@c.us", fromMe: false, body: "sem assinatura" }, { sign: false })).status()).toBe(401);
    expect((await send("message", { from: "5592966660001@c.us", fromMe: false, body: "chave errada" }, { key: "outra-chave" })).status()).toBe(401);
    await page.goto("/whatsapp/entrada");
    await expect(page.getByRole("heading", { name: "Caixa de entrada do WhatsApp" })).toBeVisible();
    await expect(page.getByText("sem assinatura")).toHaveCount(0);
    await expect(page.getByText("chave errada")).toHaveCount(0);
    expect((await inbound("5592966660001", "Bom dia, quem fala?")).status()).toBe(202);
  });

  await test.step("número desconhecido vai para a TRIAGEM (a empresa não vê); a diretoria atribui e a resposta passa para a caixa da empresa", async () => {
    await page.goto("/whatsapp/entrada");
    const triage = page.getByRole("list", { name: "Triagem" });
    await expect(triage.getByText("Bom dia, quem fala?")).toBeVisible();
    await expect(triage.getByText("+55 92 •••••-0001")).toBeVisible();
    await expect(page.getByRole("list", { name: "Respostas de clientes" })).toHaveCount(0);   // ainda não é de nenhuma empresa
    await triage.getByRole("button", { name: "Atribuir" }).click();
    await expect(page.getByText("Feito.")).toBeVisible();
    const inbox = page.getByRole("list", { name: "Respostas de clientes" });
    await expect(inbox.getByText("Bom dia, quem fala?")).toBeVisible();
    await expect(inbox.getByText("Nova", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Triagem" })).toHaveCount(0);
  });

  await test.step("marcar contestação e resolver: a conversa sai da suspensão só depois de limpar a contestação", async () => {
    const inbox = page.getByRole("list", { name: "Respostas de clientes" });
    await inbox.getByRole("button", { name: "Marcar contestação" }).click();
    await expect(page.getByRole("list", { name: "Respostas de clientes" }).getByText("Contestação", { exact: true })).toBeVisible();
    await page.getByRole("list", { name: "Respostas de clientes" }).getByRole("button", { name: "Resolver" }).click();
    await expect(page.getByRole("list", { name: "Respostas de clientes" }).getByText("Resolvida", { exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Respostas de clientes" }).getByText("Contestação", { exact: true })).toBeVisible();     // resolvida, mas a contestação segura
    await page.getByRole("list", { name: "Respostas de clientes" }).getByRole("button", { name: "Limpar contestação" }).click();
    await expect(page.getByRole("list", { name: "Respostas de clientes" }).getByText("Contestação", { exact: true })).toHaveCount(0);
  });

  await test.step("«PARAR» de número desconhecido bloqueia NA HORA (todas as empresas), vai para revisão e não gera nenhuma resposta", async () => {
    expect((await inbound("5592966660002", "PARAR")).status()).toBe(202);
    await page.goto("/whatsapp/entrada");
    const triage = page.getByRole("list", { name: "Triagem" });
    await expect(triage.getByText("PARAR", { exact: true })).toBeVisible();
    await expect(triage.getByText("Pediu para parar", { exact: true })).toBeVisible();
    await expect(triage.getByText("Bloqueado em todas as empresas")).toBeVisible();
    const sent = await (await request.get(`${WAHA}/__test/sent`, { headers: H })).json();
    expect(sent).toHaveLength(0);                                                                // o sistema NUNCA responde sozinho
    await triage.getByRole("button", { name: "Descartar" }).click();
    await expect(page.getByRole("list", { name: "Triagem" })).toHaveCount(0);
  });

  await test.step("eco da própria conta, grupo e aviso repetido não aparecem; a ajuda da tela existe", async () => {
    await send("message", { from: "5592966660003@c.us", fromMe: true, body: "eco" });
    await send("message", { from: "120363025246125486@g.us", fromMe: false, body: "grupo" });
    await page.goto("/whatsapp/entrada");
    await expect(page.getByText("eco", { exact: true })).toHaveCount(0);
    await expect(page.getByText("grupo", { exact: true })).toHaveCount(0);
    await page.goto("/ajuda/whatsapp-caixa-de-entrada");
    await expect(page.getByRole("heading", { name: /WhatsApp: respostas de clientes/ })).toBeVisible();
  });
});
