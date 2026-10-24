import { eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, emailAccounts } from "@/lib/db/schema";
import { seal, SecretBoxUnavailable } from "@/lib/security/secretbox";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { emailContext } from "./email-secrets";
import { parseEmailAddress, parseFromName, parseHost, parsePort, parseSecurity, parseSmtpPassword, parseSmtpUser, type Security } from "./email";

/**
 * E22 — cadastro da conta de e-mail (SMTP) por empresa. Só diretoria (`providers.credentials`).
 * Usuário e senha: ESCRITA APENAS (cifrados, nunca voltam para a tela). Servidor, porta, segurança e remetente aparecem (não são segredo).
 * Guardar NÃO liga o envio: EMAIL_EXTERNAL_ENABLED segue desligada e o adaptador real de e-mail não existe (E10b).
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });

export type EmailStatus = { configured: false } | { configured: true; host: string; port: number; security: Security; fromEmail: string; fromName: string | null; replyTo: string | null; updatedAt: Date };

export async function getEmailStatus(db: DB, actorId: string, companyId: string): Promise<EmailStatus> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const [r] = await db.select().from(emailAccounts).where(eq(emailAccounts.companyId, companyId));
  return r ? { configured: true, host: r.host, port: r.port, security: r.security as Security, fromEmail: r.fromEmail, fromName: r.fromName, replyTo: r.replyTo, updatedAt: r.updatedAt } : { configured: false };
}

export async function hasEmailAccount(db: DB, actorId: string, companyId: string): Promise<boolean> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  return (await db.select({ id: emailAccounts.id }).from(emailAccounts).where(eq(emailAccounts.companyId, companyId))).length > 0;
}

export type EmailInput = { host: string; port: unknown; security: unknown; fromEmail: string; fromName?: string; replyTo?: string; user?: string; password?: string };

/** Usuário e senha em branco, com conta já cadastrada, MANTÊM os atuais (dá para corrigir o remetente sem digitar a senha de novo). */
export async function saveEmailAccount(db: DB, actorId: string, companyId: string, input: EmailInput) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const host = parseHost(input.host ?? "");
  const port = parsePort(input.port);
  const security = parseSecurity(input.security, port);
  const fromEmail = parseEmailAddress(input.fromEmail ?? "", "o e-mail remetente")!;
  const fromName = parseFromName(input.fromName ?? "");
  const replyTo = parseEmailAddress(input.replyTo ?? "", "o e-mail de resposta", false);
  const user = (input.user ?? "").trim() ? parseSmtpUser(input.user!) : null;
  const password = input.password ? parseSmtpPassword(input.password) : null;
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [prev] = await x.select().from(emailAccounts).where(eq(emailAccounts.companyId, companyId)).for("update");
    if (!prev && (!user || !password)) throw new Invalid("Informe o usuário e a senha do SMTP");
    let userEnc = prev?.userEnc ?? "", passEnc = prev?.passEnc ?? "";
    try {
      if (user) userEnc = seal(user, emailContext(companyId, "user"));
      if (password) passEnc = seal(password, emailContext(companyId, "password"));
    } catch (e) { if (e instanceof SecretBoxUnavailable) throw new Invalid(e.message); throw e; }
    await x.insert(emailAccounts).values({ companyId, host, port, security, fromEmail, fromName, replyTo, userEnc, passEnc, updatedBy: actorId })
      .onConflictDoUpdate({ target: emailAccounts.companyId, set: { host, port, security, fromEmail, fromName, replyTo, userEnc, passEnc, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "provider.email_saved", { provider: "smtp", replaced: !!prev, credentialsChanged: !!(user || password) });
    return { replaced: !!prev };
  });
}

export async function removeEmailAccount(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const gone = await x.delete(emailAccounts).where(eq(emailAccounts.companyId, companyId)).returning({ id: emailAccounts.id });
    if (!gone.length) throw new Invalid("Não há conta de e-mail cadastrada");
    await audit(x, companyId, actorId, "provider.email_removed", { provider: "smtp" });
  });
}
