import { describe, expect, it } from "vitest";
import { isForbiddenIp, resolvePublicAddress } from "@/modules/providers/net-guard";
import { createSmtpEmailProvider, isAllowed, mapSmtpError, type SmtpConfig } from "@/modules/providers/smtp";

const cfg: SmtpConfig = { host: "smtp.k3gsolutions.com.br", port: 587, security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: null, user: "u", password: "p" };
const PUBLIC = async () => [{ address: "93.184.216.34", family: 4 }];
const msg = (o: Record<string, unknown> = {}) => ({ to: ["a@k3gsolutions.com.br"], subject: "s", text: "t", html: "<p>t</p>", idempotencyKey: "msg-1", ...o });
type Sent = { o: Record<string, unknown>; m: Record<string, unknown> };
const stub = (behavior: (m: Record<string, unknown>) => Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>) => {
  const sent: Sent[] = []; let created = 0;
  return { sent, created: () => created, deps: { lookup: PUBLIC, createTransport: (o: Record<string, unknown>) => { created++; return { sendMail: async (m: Record<string, unknown>) => { sent.push({ o, m }); return behavior(m); }, close() {} }; } } };
};
const ok = async (m: Record<string, unknown>) => ({ messageId: "<abc@x>", accepted: m.to as string[], rejected: [] });

describe("E23 — isForbiddenIp (proteção contra SSRF)", () => {
  it("bloqueia privados, loopback, link-local, reservados, multicast e lixo", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.2.5", "198.18.0.1", "203.0.113.9", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:a00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "999.1.1.1", "abc", "", "1.2.3"]) expect(isForbiddenIp(ip), ip).toBe(true);
  });
  it("aceita públicos", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) expect(isForbiddenIp(ip), ip).toBe(false);
  });
  it("resolve: qualquer resposta proibida invalida o nome; prefere IPv4", async () => {
    await expect(resolvePublicAddress("x.com", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }])).rejects.toThrow("servidor_interno_bloqueado");
    await expect(resolvePublicAddress("x.com", async () => [])).rejects.toThrow("dns_sem_resposta");
    expect(await resolvePublicAddress("x.com", async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }])).toEqual({ address: "8.8.8.8", family: 4 });
  });
});

describe("E23 — lista de destinatários", () => {
  it("endereço exato ou domínio exato; subdomínio e lixo não valem", () => {
    const l = ["fulano@x.com", "@k3gsolutions.com.br"];
    expect(isAllowed("Fulano@X.com", l)).toBe(true); expect(isAllowed("a@k3gsolutions.com.br", l)).toBe(true);
    expect(isAllowed("a@sub.k3gsolutions.com.br", l)).toBe(false); expect(isAllowed("a@evilk3gsolutions.com.br", l)).toBe(false); expect(isAllowed("outro@x.com", l)).toBe(false);
    expect(isAllowed("@k3gsolutions.com.br", l)).toBe(false); expect(isAllowed("", l)).toBe(false); expect(isAllowed("a@k3gsolutions.com.br", [])).toBe(false);
  });
});

describe("E23 — mapeamento de erros do SMTP", () => {
  it("antes do conteúdo: repetir é seguro; depois: desconhecido", () => {
    expect(mapSmtpError({ responseCode: 421 })).toEqual({ ok: false, retryable: true, error: "smtp_421" });
    expect(mapSmtpError({ responseCode: 550 })).toEqual({ ok: false, retryable: false, error: "smtp_550" });
    expect(mapSmtpError({ responseCode: 535, command: "AUTH" })).toMatchObject({ retryable: false, error: "autenticacao_recusada" });
    expect(mapSmtpError({ code: "EAUTH" })).toMatchObject({ error: "autenticacao_recusada" });
    expect(mapSmtpError({ code: "ECONNECTION", command: "CONN" })).toEqual({ ok: false, retryable: true, error: "falha_antes_do_envio" });
    expect(mapSmtpError({ code: "ETIMEDOUT", command: "CONN" })).toMatchObject({ retryable: true });
    expect(mapSmtpError({ code: "ETLS" })).toMatchObject({ error: "tls_recusado" });
    expect(mapSmtpError({ code: "ETIMEDOUT" })).toMatchObject({ ok: false, unknown: true, error: "resultado_desconhecido" });
    expect(mapSmtpError({ code: "ESOCKET", command: "DATA" })).toMatchObject({ unknown: true });
    expect(mapSmtpError(new Error("qualquer"))).toMatchObject({ unknown: true });
  });
});

describe("E23 — adaptador SMTP (transporte simulado)", () => {
  it("envia só a quem está na lista, conectando no IP validado com TLS verificado pelo nome", async () => {
    const s = stub(ok);
    const p = createSmtpEmailProvider(cfg, ["@k3gsolutions.com.br"], s.deps);
    expect(p.mode).toBe("live");
    const r = await p.send(msg());
    expect(r).toEqual({ ok: true, providerRef: "abc@x" });
    expect(s.sent[0].o).toMatchObject({ host: "93.184.216.34", port: 587, secure: false, requireTLS: true, tls: { servername: "smtp.k3gsolutions.com.br", rejectUnauthorized: true, minVersion: "TLSv1.2" }, disableFileAccess: true, disableUrlAccess: true, pool: false });
    expect(s.sent[0].m).toMatchObject({ from: { name: "K3G", address: "financeiro@k3gsolutions.com.br" }, to: ["a@k3gsolutions.com.br"], subject: "s", messageId: "<msg-1@k3gsolutions.com.br>" });
    const s2 = stub(ok);
    await createSmtpEmailProvider({ ...cfg, port: 465, security: "ssl" }, ["@k3gsolutions.com.br"], s2.deps).send(msg());
    expect(s2.sent[0].o).toMatchObject({ secure: true, requireTLS: false });
  });
  it("recusa ANTES de abrir qualquer conexão: fora da lista, sem chave, destinatários demais, servidor interno", async () => {
    const s = stub(ok);
    const p = createSmtpEmailProvider(cfg, ["@k3gsolutions.com.br"], s.deps);
    expect(await p.send(msg({ to: ["x@outro.com"] }))).toMatchObject({ ok: false, error: "destinatario_nao_autorizado", retryable: false });
    expect(await p.send(msg({ to: ["a@k3gsolutions.com.br", "x@outro.com"] }))).toMatchObject({ error: "destinatario_nao_autorizado" });
    expect(await p.send(msg({ idempotencyKey: "" }))).toMatchObject({ error: "idempotency_key_ausente" });
    expect(await p.send(msg({ to: [] }))).toMatchObject({ error: "destinatarios_invalidos" });
    expect(await p.send(msg({ to: Array(4).fill("a@k3gsolutions.com.br") }))).toMatchObject({ error: "destinatarios_invalidos" });
    const internal = stub(ok); internal.deps.lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    expect(await createSmtpEmailProvider(cfg, ["@k3gsolutions.com.br"], internal.deps).send(msg())).toMatchObject({ ok: false, error: "servidor_interno_bloqueado", retryable: false });
    expect(s.created()).toBe(0); expect(internal.created()).toBe(0);
  });
  it("DNS que não responde dentro do prazo não trava o envio (Codex E23 P2)", async () => {
    const hang = stub(ok); hang.deps.lookup = () => new Promise(() => {}); // nunca resolve
    const p = createSmtpEmailProvider(cfg, ["@k3gsolutions.com.br"], hang.deps);
    const t0 = Date.now();
    const r = await Promise.race([p.send(msg()), new Promise<"travou">((res) => setTimeout(() => res("travou"), 12_500))]);
    expect(r).toMatchObject({ ok: false, error: "dns_falhou", retryable: true }); expect(Date.now() - t0).toBeLessThan(12_000);
    expect(hang.created()).toBe(0);
  }, 15_000);
  it("resultados: recusado, aceito zero, desconhecido", async () => {
    const mk = (b: Parameters<typeof stub>[0]) => createSmtpEmailProvider(cfg, ["@k3gsolutions.com.br"], stub(b).deps);
    expect(await mk(async () => { throw Object.assign(new Error("x"), { responseCode: 550 }); }).send(msg())).toMatchObject({ ok: false, retryable: false, error: "smtp_550" });
    expect(await mk(async () => { throw Object.assign(new Error("x"), { responseCode: 421 }); }).send(msg())).toMatchObject({ ok: false, retryable: true });
    expect(await mk(async () => ({ messageId: "<m>", accepted: [], rejected: ["a@k3gsolutions.com.br"] })).send(msg())).toMatchObject({ ok: false, error: "destinatario_recusado" });
    expect(await mk(async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); }).send(msg())).toMatchObject({ ok: false, unknown: true });
    expect(await mk(async () => ({ accepted: ["a@k3gsolutions.com.br"] })).send(msg({ idempotencyKey: "msg-9" }))).toMatchObject({ ok: true, providerRef: "smtp-msg-9" });
  });
});
