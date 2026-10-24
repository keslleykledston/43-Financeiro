import { and, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { open } from "@/lib/security/secretbox";
import type { CoraEnvironment } from "./cora";

/**
 * SOMENTE para o adaptador real da Cora (E10b), rodando no servidor. Devolve os segredos EM CLARO: nunca registrar, nunca enviar ao navegador.
 * Não tem checagem de usuário de propósito (o adaptador roda sem sessão, a mando do agendador); por isso NENHUM outro arquivo pode importar este módulo:
 * `tests/cora-secrets-guard.test.ts` falha se alguém além do adaptador autorizado importar. Hoje ninguém importa (só os testes de integração).
 */
export const coraContext = (companyId: string, env: CoraEnvironment, field: string) => `${companyId}|cora|${env}|${field}`;

export async function readCoraCredentials(db: DB, companyId: string, environment: CoraEnvironment): Promise<{ clientId: string; certificate: string; privateKey: string } | null> {
  const [r] = await db.select().from(providerCredentials).where(and(eq(providerCredentials.companyId, companyId), eq(providerCredentials.provider, "cora"), eq(providerCredentials.environment, environment)));
  if (!r) return null;
  return { clientId: open(r.clientIdEnc, coraContext(companyId, environment, "client_id")), certificate: open(r.certEnc, coraContext(companyId, environment, "cert")), privateKey: open(r.keyEnc, coraContext(companyId, environment, "key")) };
}
