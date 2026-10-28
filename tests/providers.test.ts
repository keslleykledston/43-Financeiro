import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProviders } from "@/modules/providers/mock";
import { LIVE_FLAGS, LiveNotAvailable, assertSimulated, getProviders, liveFlagsOn } from "@/modules/providers/registry";

describe("E09 provedores simulados (contrato)", () => {
  it("e-mail/WhatsApp: idempotente por chave, erros simulados e validação", async () => {
    const p = createMockProviders();
    const a = await p.email.send({ to: ["a@x.com"], subject: "s", text: "t", html: "t", idempotencyKey: "k1" });
    const b = await p.email.send({ to: ["a@x.com"], subject: "s", text: "t", html: "t", idempotencyKey: "k1" });
    expect(a).toEqual(b); expect(a).toMatchObject({ ok: true }); expect((a as { providerRef: string }).providerRef).toMatch(/^mock-email-[0-9a-f]{16}$/);
    expect(await p.email.send({ to: ["a@x.com"], subject: "s", text: "t", html: "t", idempotencyKey: "k2" })).not.toEqual(a);
    expect(await p.email.send({ to: [], subject: "s", text: "t", html: "t", idempotencyKey: "k" })).toMatchObject({ ok: false, retryable: false });
    expect(await p.email.send({ to: ["x@falha.test"], subject: "s", text: "t", html: "t", idempotencyKey: "k" })).toEqual({ ok: false, retryable: true, error: "falha_temporaria" });
    expect(await p.whatsapp.send({ to: "5592999990000", text: "t", idempotencyKey: "" })).toMatchObject({ ok: false, error: "idempotency_key_ausente" });
    expect(await p.whatsapp.send({ to: "x.invalido.test", text: "t", idempotencyKey: "k" })).toMatchObject({ ok: false, retryable: false });
    expect(p.email.mode).toBe("mock"); expect(p.whatsapp.mode).toBe("mock");
  });
  it("boleto (Cora simulada): idempotente, valida entrada e cancela só o que não foi pago", async () => {
    const { boleto } = createMockProviders();
    const i = { idempotencyKey: "c1", amountCents: 250000, dueDate: "2026-11-14", customerName: "Fulano", customerDocument: "11222333000181" };
    const r1 = await boleto.issue(i), r2 = await boleto.issue(i);
    expect(r1).toEqual(r2); expect(r1.status).toBe("emitido");
    expect(r1.digitableLineMasked).not.toMatch(/\d{47}/);
    await expect(boleto.issue({ ...i, amountCents: 0 })).rejects.toThrow(RangeError);
    await expect(boleto.issue({ ...i, amountCents: 1.5 })).rejects.toThrow(RangeError);
    await expect(boleto.issue({ ...i, dueDate: "14/11/2026" })).rejects.toThrow(RangeError);
    await expect(boleto.issue({ ...i, idempotencyKey: "" })).rejects.toThrow(RangeError);
    await expect(boleto.status("inexistente")).rejects.toThrow();
    await boleto.cancel(r1.providerRef); expect(await boleto.status(r1.providerRef)).toBe("cancelado");
    await expect(boleto.cancel("inexistente")).rejects.toThrow();
    expect(await boleto.status("mock-boleto-emitido-por-outra-instancia")).toBe("emitido");  // o simulador não guarda estado entre requisições do site
  });
  it("NFS-e (beta): emissão assíncrona exige reconsulta", async () => {
    const { nfse } = createMockProviders();
    const r = await nfse.issue({ idempotencyKey: "n1", amountCents: 100, competence: "2026-10", customerName: "F", customerDocument: "1", description: "d" });
    expect(r.status).toBe("processando");
    expect(await nfse.issue({ idempotencyKey: "n1", amountCents: 100, competence: "2026-10", customerName: "F", customerDocument: "1", description: "d" })).toEqual(r);
    expect(await nfse.status(r.providerRef)).toBe("emitida");
    await expect(nfse.issue({ idempotencyKey: "", amountCents: 100, competence: "2026-10", customerName: "F", customerDocument: "1", description: "d" })).rejects.toThrow(RangeError);
  });
  it("falha FECHADA: qualquer chave *_LIVE ligada recusa em vez de enviar ou fingir", () => {
    expect(liveFlagsOn({})).toEqual([]);
    expect(getProviders({}).email.mode).toBe("mock");
    for (const f of LIVE_FLAGS.filter((x) => x !== "EMAIL_EXTERNAL_ENABLED")) {
      expect(() => getProviders({ [f]: "true" })).toThrow(LiveNotAvailable);
      expect(() => getProviders({ [f]: "false" })).not.toThrow();
    }
    // e-mail (E23): a chave sozinha NÃO envia nada (os provedores resolvidos seguem simulados); o envio real depende de autorização registrada por empresa
    expect(getProviders({ EMAIL_EXTERNAL_ENABLED: "true" }).email.mode).toBe("mock");
    expect(liveFlagsOn({ EMAIL_EXTERNAL_ENABLED: "true" })).toEqual(["EMAIL_EXTERNAL_ENABLED"]);
  });
  it("assertSimulated recusa provedor injetado não simulado e chaves reais", () => {
    const m = createMockProviders();
    expect(assertSimulated(m, {})).toBe(m);
    expect(() => assertSimulated({ ...m, whatsapp: { mode: "live", send: async () => ({ ok: true, providerRef: "x" }) } }, {})).toThrow(/whatsapp/);
    expect(() => assertSimulated(m, { WHATSAPP_LIVE_ENABLED: "true" })).toThrow(LiveNotAvailable);
  });
  it("rede só nos adaptadores reais (e-mail E23 e cliente Cora E10b): nenhum outro arquivo dos provedores abre conexão", () => {
    const dir = join(process.cwd(), "src/modules/providers");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      // cora-http.ts é o ÚNICO que fala HTTPS (mTLS), e só por node:https; nada de fetch/http/tls/dgram nem bibliotecas de terceiros
      expect(src, f).not.toMatch(f === "cora-http.ts" ? /\bfetch\s*\(|node:(http|tls|dgram)["']|from "(undici|axios|got)"|XMLHttpRequest/ : /\bfetch\s*\(|node:(http|https|tls|dgram)|from "(undici|axios|got)"|XMLHttpRequest/);
      if (f !== "smtp.ts") expect(src, f).not.toMatch(/nodemailer|node:dns/); // só o adaptador SMTP resolve DNS e abre conexão
      if (f !== "net-guard.ts") expect(src, f).not.toMatch(/node:net/); // net-guard só usa isIPv4/isIPv6 (sem sockets)
    }
    expect(readFileSync(join(dir, "net-guard.ts"), "utf8")).not.toMatch(/createConnection|connect\s*\(|Socket/);
  });
});
