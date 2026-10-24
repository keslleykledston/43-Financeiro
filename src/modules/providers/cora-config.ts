import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, providerCredentials } from "@/lib/db/schema";
import { seal, SecretBoxUnavailable } from "@/lib/security/secretbox";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { coraContext as ctxOf } from "./cora-secrets";
import { CORA_ENVIRONMENTS, parseCertificate, parseClientId, parseLabel, parsePrivateKey, type CoraEnvironment } from "./cora";

/**
 * E19 — cadastro das credenciais da Cora (por empresa e ambiente). Só diretoria (`providers.credentials`).
 * ESCRITA APENAS: o que é digitado é validado, cifrado e guardado; nada volta para a tela (só impressão digital e validade do certificado).
 * Guardar credenciais não liga emissão nenhuma: o adaptador real ainda não existe e as chaves *_LIVE_ENABLED seguem desligadas (E10b).
 */
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const envOk = (e: string): e is CoraEnvironment => (CORA_ENVIRONMENTS as readonly string[]).includes(e);

export type CoraStatus = { environment: CoraEnvironment; configured: boolean; label?: string | null; fingerprint?: string; notAfter?: string; daysLeft?: number; updatedAt?: Date };

export async function getCoraStatus(db: DB, actorId: string, companyId: string, today = new Date()): Promise<CoraStatus[]> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const rows = await db.select({ environment: providerCredentials.environment, label: providerCredentials.label, fp: providerCredentials.certFingerprint, notAfter: providerCredentials.certNotAfter, updatedAt: providerCredentials.updatedAt })
    .from(providerCredentials).where(and(eq(providerCredentials.companyId, companyId), eq(providerCredentials.provider, "cora")));
  return CORA_ENVIRONMENTS.map((environment) => {
    const r = rows.find((x) => x.environment === environment);
    if (!r) return { environment, configured: false };
    const daysLeft = Math.floor((Date.parse(`${r.notAfter}T23:59:59Z`) - today.getTime()) / 86_400_000);
    return { environment, configured: true, label: r.label, fingerprint: r.fp.slice(0, 16), notAfter: r.notAfter, daysLeft, updatedAt: r.updatedAt };
  });
}

/** Existe credencial Cora cadastrada (qualquer ambiente)? Só para quem pode vê-las (alimenta o checklist do portão). */
export async function hasCoraCredentials(db: DB, actorId: string, companyId: string): Promise<boolean> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(providerCredentials).where(and(eq(providerCredentials.companyId, companyId), eq(providerCredentials.provider, "cora")));
  return (r?.n ?? 0) > 0;
}

export type CoraInput = { environment: string; label?: string; clientId: string; certificate: string; privateKey: string };

export async function saveCoraCredentials(db: DB, actorId: string, companyId: string, input: CoraInput, now = new Date()) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  if (!envOk(input.environment)) throw new Invalid("Ambiente inválido");
  const env = input.environment;
  const clientId = parseClientId(input.clientId ?? "");
  const label = parseLabel(input.label ?? "");
  const cert = parseCertificate(input.certificate ?? "", now);
  const key = parsePrivateKey(input.privateKey ?? "", cert.pem);
  let clientIdEnc: string, certEnc: string, keyEnc: string;
  try {
    clientIdEnc = seal(clientId, ctxOf(companyId, env, "client_id"));
    certEnc = seal(cert.pem, ctxOf(companyId, env, "cert"));
    keyEnc = seal(key, ctxOf(companyId, env, "key"));
  } catch (e) {
    if (e instanceof SecretBoxUnavailable) throw new Invalid(e.message);
    throw e;
  }
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [prev] = await x.select({ id: providerCredentials.id }).from(providerCredentials).where(and(eq(providerCredentials.companyId, companyId), eq(providerCredentials.provider, "cora"), eq(providerCredentials.environment, env)));
    await x.insert(providerCredentials).values({ companyId, provider: "cora", environment: env, label, clientIdEnc, certEnc, keyEnc, certFingerprint: cert.fingerprint, certNotAfter: cert.notAfter, updatedBy: actorId })
      .onConflictDoUpdate({ target: [providerCredentials.companyId, providerCredentials.provider, providerCredentials.environment], set: { label, clientIdEnc, certEnc, keyEnc, certFingerprint: cert.fingerprint, certNotAfter: cert.notAfter, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "provider.credentials_saved", { provider: "cora", environment: env, replaced: !!prev, fingerprint: cert.fingerprint.slice(0, 12), notAfter: cert.notAfter });
  });
  return { fingerprint: cert.fingerprint.slice(0, 16), notAfter: cert.notAfter };
}

export async function removeCoraCredentials(db: DB, actorId: string, companyId: string, environment: string) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  if (!envOk(environment)) throw new Invalid("Ambiente inválido");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const gone = await x.delete(providerCredentials).where(and(eq(providerCredentials.companyId, companyId), eq(providerCredentials.provider, "cora"), eq(providerCredentials.environment, environment))).returning({ id: providerCredentials.id });
    if (!gone.length) throw new Invalid("Não há credenciais deste ambiente");
    await audit(x, companyId, actorId, "provider.credentials_removed", { provider: "cora", environment });
  });
}
