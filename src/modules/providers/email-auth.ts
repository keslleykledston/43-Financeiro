import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, emailAccounts, emailLiveAuthorizations } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { parseEmailAddress } from "./email";
import { activeAuthorization, flagOn, sentToday } from "./email-live";

/**
 * E23 — autorização de envio real de e-mail (canário), registrada pela diretoria. É a "autorização explícita, por provedor e por empresa, com limites"
 * do portão (docs/E10_GOLIVE.md): referência do documento/mensagem escrita, quem pode receber, limite diário. Histórico imutável (revogar, não editar).
 * Registrar isto NÃO envia nada: o servidor ainda precisa estar com EMAIL_EXTERNAL_ENABLED=true.
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const DOMAIN = /^@(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "a@x.com, @minhaempresa.com.br" → lista normalizada. Domínio inteiro SÓ do domínio do remetente (canário interno); fora dele, endereço a endereço. */
export function parseAllowed(raw: string, ownDomain: string): string[] {
  const parts = [...new Set(String(raw ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (parts.length === 0) throw new Invalid("Informe ao menos um destinatário autorizado");
  if (parts.length > 20) throw new Invalid("No máximo 20 destinatários autorizados");
  return parts.map((p) => {
    if (p.startsWith("@")) {
      if (!DOMAIN.test(p)) throw new Invalid(`Domínio inválido: ${p}`);
      if (p !== `@${ownDomain}`) throw new Invalid(`Domínio inteiro só é aceito para o domínio do remetente (@${ownDomain}). Para outros, informe endereço por endereço`);
      return p;
    }
    return parseEmailAddress(p, "o destinatário autorizado")!;
  });
}

export async function getEmailLiveStatus(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const a = await activeAuthorization(db, companyId);
  return { flag: flagOn(), authorization: a ? { id: a.id, reference: a.reference, allowed: a.allowed, dailyLimit: a.dailyLimit, at: a.createdAt } : null, sentToday: await sentToday(db, companyId) };
}

export async function authorizeEmailLive(db: DB, actorId: string, companyId: string, input: { reference: string; allowed: string; dailyLimit: unknown }) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const reference = String(input.reference ?? "").replace(/\s+/g, " ").trim();
  if (reference.length < 5 || reference.length > 200) throw new Invalid("Informe a referência da autorização escrita (de 5 a 200 caracteres): onde ela está registrada");
  const limit = Number(input.dailyLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Invalid("Limite diário: um número de 1 a 200");
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"email-live:" + companyId}))`); // mesmo lock da reserva de envios: revogar/substituir espera a reserva em curso
    const [acc] = await x.select({ fromEmail: emailAccounts.fromEmail }).from(emailAccounts).where(eq(emailAccounts.companyId, companyId));
    if (!acc) throw new Invalid("Cadastre antes a conta de e-mail da empresa");
    const allowed = parseAllowed(input.allowed, acc.fromEmail.slice(acc.fromEmail.lastIndexOf("@") + 1));
    const prev = await activeAuthorization(x, companyId);
    if (prev) await x.update(emailLiveAuthorizations).set({ active: false, revokedAt: new Date(), revokedBy: actorId, updatedAt: new Date() }).where(eq(emailLiveAuthorizations.id, prev.id));
    const [a] = await x.insert(emailLiveAuthorizations).values({ companyId, reference, allowed, dailyLimit: limit, authorizedBy: actorId }).returning({ id: emailLiveAuthorizations.id });
    await audit(x, companyId, actorId, "email.live_authorized", { authorizationId: a.id, recipients: allowed.length, dailyLimit: limit, replaced: !!prev });
    return { id: a.id };
  });
}

export async function revokeEmailLive(db: DB, actorId: string, companyId: string) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"email-live:" + companyId}))`);
    const prev = await activeAuthorization(x, companyId);
    if (!prev) throw new Invalid("Não há autorização ativa");
    await x.update(emailLiveAuthorizations).set({ active: false, revokedAt: new Date(), revokedBy: actorId, updatedAt: new Date() }).where(and(eq(emailLiveAuthorizations.id, prev.id), eq(emailLiveAuthorizations.active, true)));
    await audit(x, companyId, actorId, "email.live_revoked", { authorizationId: prev.id });
  });
}
