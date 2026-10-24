import { eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { emailAccounts } from "@/lib/db/schema";
import { open } from "@/lib/security/secretbox";
import type { Security } from "./email";

/**
 * SOMENTE para o adaptador real de e-mail (E10b), rodando no servidor. Devolve usuário e senha EM CLARO: nunca registrar, nunca enviar ao navegador.
 * Sem checagem de usuário de propósito (o adaptador roda a mando do agendador); por isso NENHUM outro arquivo pode importar este módulo:
 * o teste de guarda de segredos (tests/…-guard.test.ts) falha se alguém além do adaptador autorizado importar. Hoje ninguém importa.
 */
export const emailContext = (companyId: string, field: "user" | "password") => `${companyId}|smtp|${field}`;

export async function readEmailCredentials(db: DB, companyId: string): Promise<{ host: string; port: number; security: Security; fromEmail: string; fromName: string | null; replyTo: string | null; user: string; password: string } | null> {
  const [r] = await db.select().from(emailAccounts).where(eq(emailAccounts.companyId, companyId));
  if (!r) return null;
  return { host: r.host, port: r.port, security: r.security as Security, fromEmail: r.fromEmail, fromName: r.fromName, replyTo: r.replyTo, user: open(r.userEnc, emailContext(companyId, "user")), password: open(r.passEnc, emailContext(companyId, "password")) };
}
