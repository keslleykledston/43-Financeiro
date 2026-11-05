import { X509Certificate, createPrivateKey } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import forge from "node-forge";
import type { DB } from "@/lib/db";
import { auditLog, companies, companyCertificates } from "@/lib/db/schema";
import { hit } from "@/lib/security/rate-limit";
import { SecretBoxCorrupt, SecretBoxUnavailable, seal } from "@/lib/security/secretbox";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { nfseCertContext, readNfseCertificate } from "./cert-secrets";

/**
 * N2b-0 — certificado digital A1 (e-CNPJ, ICP-Brasil) da empresa, para assinar a NFS-e Padrão Nacional (ADR-039).
 * Só diretoria (`providers.credentials`). Importa um .pfx + senha: confere, guarda CIFRADO (certificado, chave e cadeia) e DESCARTA a senha.
 * ESCRITA APENAS: nada secreto volta para a tela (só titular, validade e impressão digital). Guardar NÃO liga a emissão: o assinador e o envio são da N2b/N2c.
 */
export const MAX_PFX_BYTES = 32 * 1024;
export const WARN_DAYS = 30;
/** Teto de iterações do PKCS#12 (MAC e proteção): .pfx de certificadora usa ~2 mil a 100 mil; acima disso é arquivo feito para travar o servidor. */
export const MAX_PFX_ITERATIONS = 200_000;
export const IMPORT_MAX_PER_WINDOW = 10; const IMPORT_WINDOW_MS = 10 * 60_000;
const OID_CNPJ = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]); // 2.16.76.1.3.3 (CNPJ do titular, ICP-Brasil)
const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (to: string, now: Date) => Math.floor((Date.parse(`${to}T23:59:59Z`) - now.getTime()) / 86_400_000);

export type ParsedPfx = { icpBrasil: boolean; certPem: string; keyPem: string; chainPem: string | null; subject: string; holderCnpj: string; issuer: string; serial: string; notBefore: string; notAfter: string; fingerprint: string };

const cn = (dn: string) => (dn.match(/^CN=(.+)$/m)?.[1] ?? dn.split("\n").pop() ?? "").trim().slice(0, 200);

/** CNPJ do titular: «NOME:00000000000000» no CN do e-CNPJ ou o campo OID 2.16.76.1.3.3 do certificado. */
export function holderCnpjOf(c: X509Certificate): string | null {
  const m = cn(c.subject).match(/:(\d{14})\s*$/);
  if (m) return m[1];
  const i = c.raw.indexOf(OID_CNPJ);
  if (i >= 0) { const d = c.raw.subarray(i + OID_CNPJ.length, i + OID_CNPJ.length + 32).toString("latin1").match(/\d{14}/); if (d) return d[0]; }
  return null;
}


/** Maior contagem de iterações (INTEGER logo depois de um salt OCTET STRING) visível no ASN.1 do PKCS#12: MAC e proteção externa. */
function maxIterations(n: forge.asn1.Asn1, depth = 0): number {
  if (depth > 40 || !Array.isArray(n.value)) return 0;
  let m = 0;
  const v = n.value as forge.asn1.Asn1[];
  for (let i = 0; i < v.length; i++) {
    const nx = v[i + 1];
    if (v[i].type === forge.asn1.Type.OCTETSTRING && nx && nx.type === forge.asn1.Type.INTEGER && typeof nx.value === "string") m = Math.max(m, nx.value.length > 6 ? Number.POSITIVE_INFINITY : parseInt(forge.util.bytesToHex(nx.value) || "0", 16));
    m = Math.max(m, maxIterations(v[i], depth + 1));
  }
  return m;
}

export function parsePfx(pfx: Uint8Array, password: string, companyCnpj: string, now = new Date()): ParsedPfx {
  const buf = Buffer.from(pfx);
  if (buf.length < 100) throw new Invalid("O arquivo do certificado está vazio ou pequeno demais");
  if (buf.length > MAX_PFX_BYTES) throw new Invalid("O arquivo do certificado passa de 32 KB: não parece um .pfx de certificado A1");
  if (buf[0] !== 0x30) throw new Invalid("Este arquivo não é um certificado .pfx/.p12 (formato A1). Certificado em cartão ou token (A3) não serve");
  if (!password || password.length > 200) throw new Invalid("Informe a senha do certificado");
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(buf.toString("binary")));
    if (maxIterations(asn1) > MAX_PFX_ITERATIONS) throw new Invalid("Arquivo .pfx recusado: parâmetros de proteção fora do normal (iterações demais)");
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  }
  catch (e) {
    if (e instanceof Invalid) throw e;
    if (/MAC|password/i.test(e instanceof Error ? e.message : "")) throw new Invalid("Senha do certificado incorreta");
    throw new Invalid("Não consegui ler o .pfx: arquivo danificado ou protegido por um formato que o sistema ainda não suporta. Gere de novo na certificadora");
  }
  const keyBags = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const forgeKey = keyBags.find((b) => b.key)?.key;
  if (!forgeKey || certBags.length === 0) throw new Invalid("O arquivo não traz certificado e chave privada juntos (precisa ser o .pfx completo)");
  let keyPem: string, nodeKey: ReturnType<typeof createPrivateKey>;
  try { keyPem = forge.pki.privateKeyToPem(forgeKey as forge.pki.rsa.PrivateKey); nodeKey = createPrivateKey(keyPem); } catch { throw new Invalid("A chave privada do arquivo não é do tipo RSA esperado (certificado A1 ICP-Brasil)"); }
  const certs = certBags.flatMap((b) => (b.cert ? [forge.pki.certificateToPem(b.cert)] : [])).flatMap((pem) => { try { return [{ pem, x: new X509Certificate(pem) }]; } catch { return []; } });
  const leaf = certs.find((c) => { try { return c.x.checkPrivateKey(nodeKey); } catch { return false; } });
  if (!leaf) throw new Invalid("A chave privada do arquivo não combina com nenhum certificado dele");
  const from = new Date(leaf.x.validFrom), to = new Date(leaf.x.validTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Invalid("Certificado com datas inválidas");
  if (to < now) throw new Invalid("Certificado vencido: renove na certificadora");
  if (from > now) throw new Invalid("Certificado ainda não é válido (data de início no futuro)");
  const holder = holderCnpjOf(leaf.x);
  if (!holder) throw new Invalid("Não encontrei o CNPJ no certificado. Precisa ser um e-CNPJ (certificado da empresa), não de pessoa física");
  const mine = companyCnpj.replace(/\D/g, "");
  if (!/^\d{14}$/.test(mine)) throw new Invalid("Cadastre antes o CNPJ da empresa (Configurações → Empresa): o sistema confere se o certificado é do mesmo CNPJ");
  if (holder !== mine) throw new Invalid("O CNPJ do certificado não é o desta empresa. Importe o certificado do CNPJ da empresa selecionada");
  const chain = certs.filter((c) => c !== leaf).slice(0, 5).map((c) => c.pem.trim()).join("\n");
  return { icpBrasil: /ICP-?Brasil/i.test(leaf.x.issuer) || /ICP-?Brasil/i.test(leaf.x.subject), certPem: leaf.pem.trim(), keyPem: keyPem.trim(), chainPem: chain || null, subject: cn(leaf.x.subject), holderCnpj: holder, issuer: cn(leaf.x.issuer), serial: leaf.x.serialNumber, notBefore: day(from), notAfter: day(to), fingerprint: leaf.x.fingerprint256.replace(/:/g, "").toLowerCase() };
}

export type CertStatus = {
  active: null | { id: string; subject: string; holderCnpj: string; issuer: string; notBefore: string; notAfter: string; daysLeft: number; fingerprint: string; importedAt: Date };
  history: { status: string; notAfter: string; fingerprint: string; closedAt: Date | null }[];
};

export async function getCertificateStatus(db: DB, actorId: string, companyId: string, now = new Date()): Promise<CertStatus> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const rows = await db.select().from(companyCertificates).where(and(eq(companyCertificates.companyId, companyId), eq(companyCertificates.purpose, "nfse"))).orderBy(desc(companyCertificates.createdAt)).limit(6);
  const a = rows.find((r) => r.status === "ativo");
  return {
    active: a ? { id: a.id, subject: a.subject, holderCnpj: a.holderCnpj, issuer: a.issuer, notBefore: a.notBefore, notAfter: a.notAfter, daysLeft: daysBetween(a.notAfter, now), fingerprint: a.fingerprint.slice(0, 16), importedAt: a.createdAt } : null,
    history: rows.filter((r) => r.status !== "ativo").slice(0, 5).map((r) => ({ status: r.status, notAfter: r.notAfter, fingerprint: r.fingerprint.slice(0, 16), closedAt: r.closedAt })),
  };
}

/** Existe certificado ativo? (checklist do portão) Só para quem pode ver credenciais. */
export async function hasNfseCertificate(db: DB, actorId: string, companyId: string): Promise<boolean> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  const [r] = await db.select({ id: companyCertificates.id }).from(companyCertificates).where(and(eq(companyCertificates.companyId, companyId), eq(companyCertificates.purpose, "nfse"), eq(companyCertificates.status, "ativo")));
  return !!r;
}

export async function importCertificate(db: DB, actorId: string, companyId: string, input: { pfx: Uint8Array; password: string }, now = new Date()) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  if (await hit(db, `nfse-cert:import:${actorId}`, IMPORT_MAX_PER_WINDOW, IMPORT_WINDOW_MS, now)) throw new Invalid("Muitas tentativas de importação em pouco tempo. Aguarde alguns minutos e tente de novo");
  const [co] = await db.select({ cnpj: companies.cnpj }).from(companies).where(eq(companies.id, companyId));
  const p = parsePfx(input.pfx, String(input.password ?? ""), co?.cnpj ?? "", now); // formato, senha e validade são conferidos antes do CNPJ da empresa
  let certEnc: string, keyEnc: string, chainEnc: string | null;
  try {
    certEnc = seal(p.certPem, nfseCertContext(companyId, "cert"));
    keyEnc = seal(p.keyPem, nfseCertContext(companyId, "key"));
    chainEnc = p.chainPem ? seal(p.chainPem, nfseCertContext(companyId, "chain")) : null;
  } catch (e) { if (e instanceof SecretBoxUnavailable) throw new Invalid(e.message); throw e; }
  const replaced = await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("update"); // serializa importações da mesma empresa
    const closed = await x.update(companyCertificates).set({ status: "substituido", certEnc: null, keyEnc: null, chainEnc: null, closedBy: actorId, closedAt: now, updatedAt: now })
      .where(and(eq(companyCertificates.companyId, companyId), eq(companyCertificates.purpose, "nfse"), eq(companyCertificates.status, "ativo"))).returning({ id: companyCertificates.id });
    await x.insert(companyCertificates).values({ companyId, purpose: "nfse", status: "ativo", subject: p.subject, holderCnpj: p.holderCnpj, issuer: p.issuer, serial: p.serial, notBefore: p.notBefore, notAfter: p.notAfter, fingerprint: p.fingerprint, certEnc, keyEnc, chainEnc, createdBy: actorId });
    await audit(x, companyId, actorId, "nfse.certificate_imported", { fingerprint: p.fingerprint.slice(0, 12), notAfter: p.notAfter, replaced: closed.length > 0 });
    return closed.length > 0;
  });
  const daysLeft = daysBetween(p.notAfter, now);
  return { fingerprint: p.fingerprint.slice(0, 16), notAfter: p.notAfter, daysLeft, subject: p.subject, replaced, expiringSoon: daysLeft <= WARN_DAYS, icpBrasil: p.icpBrasil };
}

export async function removeCertificate(db: DB, actorId: string, companyId: string, now = new Date()) {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("update");
    const gone = await x.update(companyCertificates).set({ status: "removido", certEnc: null, keyEnc: null, chainEnc: null, closedBy: actorId, closedAt: now, updatedAt: now })
      .where(and(eq(companyCertificates.companyId, companyId), eq(companyCertificates.purpose, "nfse"), eq(companyCertificates.status, "ativo"))).returning({ fingerprint: companyCertificates.fingerprint });
    if (gone.length === 0) throw new Invalid("Não há certificado guardado");
    await audit(x, companyId, actorId, "nfse.certificate_removed", { fingerprint: gone[0].fingerprint.slice(0, 12) });
  });
}

/** Reabre o que está guardado e confere: decifra, a chave combina com o certificado e não venceu. Não envia nada para fora. */
export async function verifyCertificate(db: DB, actorId: string, companyId: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
  await requirePerm(db, actorId, companyId, "providers.credentials");
  try {
    const s = await readNfseCertificate(db, companyId);
    if (!s) return { ok: false, message: "Não há certificado guardado." };
    const x = new X509Certificate(s.certPem);
    if (!x.checkPrivateKey(createPrivateKey(s.keyPem))) return { ok: false, message: "A chave guardada não combina com o certificado. Importe de novo." };
    const daysLeft = daysBetween(s.notAfter, now);
    if (daysLeft < 0) return { ok: false, message: "O certificado guardado venceu. Importe o novo." };
    return { ok: true, message: `Certificado íntegro (decifra, chave confere). ${daysLeft <= WARN_DAYS ? `Atenção: vence em ${daysLeft} dia(s).` : `Vence em ${daysLeft} dias.`}` };
  } catch (e) {
    if (e instanceof SecretBoxUnavailable || e instanceof SecretBoxCorrupt) return { ok: false, message: "O cofre não conseguiu abrir o certificado (chave do servidor mudou ou o dado foi alterado). Importe de novo." };
    return { ok: false, message: "Falha ao conferir o certificado guardado." };
  }
}
