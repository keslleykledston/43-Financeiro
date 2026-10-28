// Operação auditada (E10b): move as credenciais da Cora de um ambiente para outro (re-cifra com o contexto do novo ambiente). Uso quando o certificado foi salvo na aba errada.
// Antes de mover, CONFIRMA por aperto de mão TLS (sem chamada de API) que o host do ambiente de destino aceita o certificado e o do ambiente de origem o recusa.
// Uso: OPS_FROM=homologacao OPS_TO=producao docker compose --profile tools run --rm -e OPS_FROM -e OPS_TO tools pnpm tsx scripts/ops-cora-relabel.ts
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import tls from "node:tls";

const accepts = (host: string, cert: string, key: string) => new Promise<boolean>((resolve) => {
  const overall = setTimeout(() => { s.destroy(); resolve(false); }, 10_000); // prazo desde o início da conexão
  const done = (v: boolean) => { clearTimeout(overall); s.destroy(); resolve(v); };
  const s = tls.connect({ host, port: 443, servername: host, cert, key, minVersion: "TLSv1.2" }, () => {
    const t = setTimeout(() => done(true), 3000); // 3 s sem alerta do servidor depois do aperto de mão = certificado aceito
    s.on("error", () => { clearTimeout(t); done(false); });
    s.on("close", () => { clearTimeout(t); done(false); });
  });
  s.on("error", () => done(false));
});

(async () => {
  const from = process.env.OPS_FROM, to = process.env.OPS_TO;
  if (!from || !to || from === to || !["homologacao", "producao"].includes(from) || !["homologacao", "producao"].includes(to)) throw new Error("Defina OPS_FROM e OPS_TO (homologacao|producao, diferentes)");
  const { db } = await import("../src/lib/db");
  const { and, eq } = await import("drizzle-orm");
  const { providerCredentials, auditLog } = await import("../src/lib/db/schema");
  const { seal } = await import("../src/lib/security/secretbox");
  const { readCoraCredentials, coraContext } = await import("../src/modules/providers/cora-secrets");
  const { CORA_HOSTS } = await import("../src/modules/providers/cora-http");
  const rows = await db.select().from(providerCredentials).where(and(eq(providerCredentials.provider, "cora"), eq(providerCredentials.environment, from as "homologacao")));
  for (const r of rows) {
    const [dst] = await db.select({ id: providerCredentials.id }).from(providerCredentials).where(and(eq(providerCredentials.companyId, r.companyId), eq(providerCredentials.provider, "cora"), eq(providerCredentials.environment, to)));
    if (dst) { console.log(`empresa ${r.companyId}: já existe credencial de ${to}; nada feito`); continue; }
    const c = (await readCoraCredentials(db, r.companyId, from as "homologacao"))!;
    const okTo = await accepts(CORA_HOSTS[to as "producao"], c.certificate, c.privateKey), okFrom = await accepts(CORA_HOSTS[from as "producao"], c.certificate, c.privateKey);
    console.log(`empresa ${r.companyId}: ${to} aceita=${okTo}; ${from} aceita=${okFrom}`);
    if (!okTo || okFrom) { console.log("  confirmação TLS não bate; NÃO movi"); continue; }
    await db.transaction(async (tx) => {
      await tx.insert(providerCredentials).values({
        companyId: r.companyId, provider: "cora", environment: to, label: r.label,
        clientIdEnc: seal(c.clientId, coraContext(r.companyId, to as "producao", "client_id")), certEnc: seal(c.certificate, coraContext(r.companyId, to as "producao", "cert")), keyEnc: seal(c.privateKey, coraContext(r.companyId, to as "producao", "key")),
        certFingerprint: r.certFingerprint, certNotAfter: r.certNotAfter, updatedBy: r.updatedBy,
      });
      await tx.delete(providerCredentials).where(eq(providerCredentials.id, r.id));
      await tx.insert(auditLog).values({ companyId: r.companyId, actorId: r.updatedBy, action: "provider.credentials_moved", detail: { provider: "cora", from, to, fingerprint: r.certFingerprint.slice(0, 12), via: "ops" } });
    });
    console.log(`  movido de ${from} para ${to}`);
  }
  process.exit(0);
})().catch((e) => { console.error("falha:", (e as Error).message); process.exit(1); });
