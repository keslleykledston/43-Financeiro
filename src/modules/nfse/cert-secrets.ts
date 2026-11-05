import { and, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { companyCertificates } from "@/lib/db/schema";
import { open } from "@/lib/security/secretbox";

/**
 * SOMENTE para o módulo do certificado (conferência) e, na N2b, para o assinador da NFS-e, rodando no servidor. Devolve a CHAVE PRIVADA EM CLARO:
 * nunca registrar, nunca enviar ao navegador. Sem checagem de usuário de propósito (o assinador roda sem sessão); por isso NENHUM outro arquivo pode
 * importar este módulo: `tests/nfse-cert.int.test.ts` falha se alguém além dos autorizados importar.
 */
export const nfseCertContext = (companyId: string, field: "cert" | "key" | "chain") => `${companyId}|nfse|${field}`;

export type NfseCertSecrets = { certPem: string; keyPem: string; chainPem: string | null; notAfter: string; fingerprint: string };

export async function readNfseCertificate(db: DB, companyId: string): Promise<NfseCertSecrets | null> {
  const [r] = await db.select().from(companyCertificates).where(and(eq(companyCertificates.companyId, companyId), eq(companyCertificates.purpose, "nfse"), eq(companyCertificates.status, "ativo")));
  if (!r || !r.certEnc || !r.keyEnc) return null;
  return { certPem: open(r.certEnc, nfseCertContext(companyId, "cert")), keyPem: open(r.keyEnc, nfseCertContext(companyId, "key")), chainPem: r.chainEnc ? open(r.chainEnc, nfseCertContext(companyId, "chain")) : null, notAfter: r.notAfter, fingerprint: r.fingerprint };
}
