import { lookup as dnsLookup } from "node:dns/promises";
import nodemailer from "nodemailer";
import type { EmailProvider, SendResult } from "./types";
import { resolvePublicAddress, type Lookup } from "./net-guard";
import type { Security } from "./email";

/**
 * E23 — adaptador REAL de e-mail (SMTP). Só é criado por `email-live.ts`, depois de TODAS as travas (chave do servidor, autorização registrada,
 * conta cadastrada). Defesas próprias, mesmo que um chamador falhe: lista de destinatários permitidos, servidor só em endereço público
 * (o IP validado é o usado na conexão), TLS obrigatório com certificado válido, sem anexos/arquivos/URLs, tempos limite, sem reenvio automático.
 * A chamada acontece FORA de transação do banco (reservar → enviar → registrar).
 */
export type SmtpConfig = { host: string; port: number; security: Security; fromEmail: string; fromName: string | null; replyTo: string | null; user: string; password: string };
export type Transport = { sendMail(m: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>; close?(): void };
export type SmtpDeps = { lookup?: Lookup; createTransport?: (o: Record<string, unknown>) => Transport };

const TOTAL_TIMEOUT_MS = 45_000;
const DNS_TIMEOUT_MS = 10_000;
const MAX_RECIPIENTS = 3;

/** Endereço exato ("a@x.com") ou domínio exato ("@x.com"; subdomínios NÃO valem). */
export function isAllowed(address: string, allowed: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return false;
  return allowed.some((e) => (e.startsWith("@") ? a.slice(at) === e : a === e));
}

const real = (): SmtpDeps => ({ lookup: async (h) => dnsLookup(h, { all: true, verbatim: true }) });

/** Mapeia o erro do SMTP: o que foi recusado ANTES de aceitar o conteúdo é seguro repetir; queda depois do DATA = resultado desconhecido. */
export function mapSmtpError(e: unknown): SendResult & { ok: false } {
  const err = e as { code?: string; command?: string; responseCode?: number };
  const code = typeof err?.responseCode === "number" ? err.responseCode : 0;
  if (code >= 400 && code < 500) return { ok: false, retryable: true, error: `smtp_${code}` };
  if (code >= 500 && code < 600) return { ok: false, retryable: false, error: err.command === "AUTH" || code === 535 ? "autenticacao_recusada" : `smtp_${code}` };
  const before = ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"];
  if (err?.code === "EAUTH") return { ok: false, retryable: false, error: "autenticacao_recusada" };
  if (err?.command && before.includes(err.command)) return { ok: false, retryable: true, error: "falha_antes_do_envio" };
  if (err?.code === "ECONNECTION" || err?.code === "EDNS" || err?.code === "ETLS" || err?.code === "EENVELOPE") return { ok: false, retryable: err.code !== "EENVELOPE", error: err.code === "ETLS" ? "tls_recusado" : "falha_antes_do_envio" };
  return { ok: false, retryable: false, unknown: true, error: "resultado_desconhecido" }; // timeout/queda com o conteúdo possivelmente já entregue
}

export function createSmtpEmailProvider(cfg: SmtpConfig, allowed: readonly string[], deps: SmtpDeps = {}): EmailProvider {
  const d: SmtpDeps = process.env.VITEST === "true" ? { ...real(), ...deps } : real(); // injeção só sob o executor de testes
  const make = d.createTransport ?? ((o: Record<string, unknown>) => nodemailer.createTransport(o) as unknown as Transport);
  const fromDomain = cfg.fromEmail.slice(cfg.fromEmail.lastIndexOf("@") + 1);
  return {
    mode: "live",
    async send(m) {
      if (!m.idempotencyKey) return { ok: false, retryable: false, error: "idempotency_key_ausente" };
      if (m.to.length === 0 || m.to.length > MAX_RECIPIENTS) return { ok: false, retryable: false, error: "destinatarios_invalidos" };
      if (!m.to.every((a) => isAllowed(a, allowed))) return { ok: false, retryable: false, error: "destinatario_nao_autorizado" };
      let ip: { address: string; family: number };
      try {
        let dnsTimer: ReturnType<typeof setTimeout> | undefined;
        try { ip = await Promise.race([resolvePublicAddress(cfg.host, d.lookup!), new Promise<never>((_, rej) => { dnsTimer = setTimeout(() => rej(new Error("dns_sem_resposta")), DNS_TIMEOUT_MS); })]); }
        finally { if (dnsTimer) clearTimeout(dnsTimer); }
      }
      catch (e) { const msg = (e as Error).message; return { ok: false, retryable: msg === "dns_sem_resposta", error: msg === "servidor_interno_bloqueado" ? msg : "dns_falhou" }; }
      const transport = make({
        host: ip.address, port: cfg.port, secure: cfg.security === "ssl", requireTLS: cfg.security === "starttls", name: fromDomain,
        auth: { user: cfg.user, pass: cfg.password },
        tls: { servername: cfg.host, minVersion: "TLSv1.2", rejectUnauthorized: true },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000, disableFileAccess: true, disableUrlAccess: true, pool: false,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const info = await Promise.race([
          transport.sendMail({
            from: { name: cfg.fromName ?? "", address: cfg.fromEmail }, to: m.to, replyTo: cfg.replyTo ?? undefined, subject: m.subject, text: m.text, html: m.html,
            messageId: `<${m.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, "")}@${fromDomain}>`,
          }),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), TOTAL_TIMEOUT_MS); }),
        ]);
        const accepted = info.accepted?.length ?? 0;
        if (accepted === 0) return { ok: false, retryable: false, error: "destinatario_recusado" };
        return { ok: true, providerRef: String(info.messageId ?? "").replace(/^<|>$/g, "").slice(0, 120) || `smtp-${m.idempotencyKey.slice(0, 40)}` };
      } catch (e) { return mapSmtpError(e); }
      finally { if (timer) clearTimeout(timer); try { transport.close?.(); } catch { /* nada a fazer */ } }
    },
  };
}
