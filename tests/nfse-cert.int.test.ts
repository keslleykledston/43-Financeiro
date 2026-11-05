import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import forge from "node-forge";
import { MAX_PFX_ITERATIONS, getCertificateStatus, hasNfseCertificate, importCertificate, parsePfx, removeCertificate, verifyCertificate } from "@/modules/nfse/certificate";
import { readNfseCertificate } from "@/modules/nfse/cert-secrets";
import { makePfx } from "./helpers/pfx";

const PW = "Senha-SECRETA-do-pfx-123";
const CNPJ = "11222333000181";

describe("parsePfx (sem banco)", () => {
  const ok = makePfx({ password: PW });
  it("lê o e-CNPJ: titular, validade, impressão digital, chave RSA; descarta a senha", () => {
    const p = parsePfx(ok, PW, "11.222.333/0001-81");
    expect(p.holderCnpj).toBe(CNPJ); expect(p.subject).toBe(`EMPRESA TESTE LTDA:${CNPJ}`);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/); expect(p.keyPem).toContain("BEGIN RSA PRIVATE KEY"); expect(p.certPem).toContain("BEGIN CERTIFICATE"); expect(p.chainPem).toBeNull();
    expect(JSON.stringify(p)).not.toContain(PW);
  });
  it("senha errada, CNPJ de outra empresa, vencido, ainda não válido, sem CNPJ, não-.pfx e tamanho", () => {
    expect(() => parsePfx(ok, "outra", CNPJ)).toThrow(/Senha do certificado incorreta/);
    expect(() => parsePfx(ok, PW, "45723174000110")).toThrow(/não é o desta empresa/);
    expect(() => parsePfx(ok, PW, CNPJ, new Date(Date.now() + 400 * 86_400_000))).toThrow(/vencido/);
    expect(() => parsePfx(makePfx({ password: PW, notBefore: new Date(Date.now() + 5 * 86_400_000) }), PW, CNPJ)).toThrow(/ainda não é válido/);
    expect(() => parsePfx(makePfx({ password: PW, cn: "FULANO DE TAL" }), PW, CNPJ)).toThrow(/Não encontrei o CNPJ/);
    expect(() => parsePfx(Buffer.from("isto é texto, não um pfx. ".repeat(10)), PW, CNPJ)).toThrow(/não é um certificado/);
    expect(() => parsePfx(Buffer.alloc(40000, 0x30), PW, CNPJ)).toThrow(/passa de 32 KB/);
    expect(() => parsePfx(Buffer.alloc(10), PW, CNPJ)).toThrow(/vazio/);
    expect(() => parsePfx(ok, "", CNPJ)).toThrow(/Informe a senha/);
    expect(() => parsePfx(Buffer.concat([Buffer.from([0x30]), Buffer.alloc(300, 7)]), PW, CNPJ)).toThrow(/Não consegui ler o \.pfx/);
  });
  it("emissor fora da ICP-Brasil é marcado (aviso), e arquivo com iterações absurdas é recusado antes de decifrar", () => {
    expect(parsePfx(ok, PW, CNPJ).icpBrasil).toBe(true);
    expect(parsePfx(makePfx({ password: PW, icp: false }), PW, CNPJ).icpBrasil).toBe(false);
    // MAC com iterações acima do teto: troca o INTEGER das iterações no DER
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(ok.toString("binary")));
    const mac = (asn1.value as forge.asn1.Asn1[])[2];
    (mac.value as forge.asn1.Asn1[])[2] = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.INTEGER, false, forge.util.hexToBytes("0f4241")); // 1.000.001
    const bomb = Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
    expect(MAX_PFX_ITERATIONS).toBeLessThan(1_000_001);
    expect(() => parsePfx(bomb, PW, CNPJ)).toThrow(/iterações demais/);
  });
  it("guarda a cadeia (AC) quando o arquivo a traz", () => {
    const p = parsePfx(makePfx({ password: PW, withCa: true }), PW, CNPJ);
    expect(p.chainPem).toContain("BEGIN CERTIFICATE");
  });
});

describe.skipIf(!process.env.POSTGRES_USER)("certificado A1 da NFS-e (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, contA: string, noCnpj: string, dirN: string;

  beforeAll(async () => {
    process.env.K3G_CREDENTIALS_KEY = "chave-de-teste-0123456789abcdef-0123456789";
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate company_certificates, rate_limits, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b, n] = await db.insert(schema.companies).values([{ name: "A", cnpj: CNPJ }, { name: "B", cnpj: "45723174000110" }, { name: "Sem CNPJ" }]).returning();
    A = a.id; B = b.id; noCnpj = n.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); contA = await mk("cont@t.com"); dirN = await mk("dir-n@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: contA, companyId: A, role: "contabilidade" }, { userId: dirN, companyId: noCnpj, role: "diretoria" }]);
  });

  it("só a diretoria da empresa importa, vê, confere e remove", async () => {
    const pfx = makePfx({ password: PW });
    for (const u of [gerA, contA]) {
      await expect(importCertificate(db, u, A, { pfx, password: PW })).rejects.toBeInstanceOf(Forbidden);
      await expect(getCertificateStatus(db, u, A)).rejects.toBeInstanceOf(Forbidden);
      await expect(verifyCertificate(db, u, A)).rejects.toBeInstanceOf(Forbidden);
      await expect(removeCertificate(db, u, A)).rejects.toBeInstanceOf(Forbidden);
      await expect(hasNfseCertificate(db, u, A)).rejects.toBeInstanceOf(Forbidden);
    }
    await expect(importCertificate(db, dirB, A, { pfx, password: PW })).rejects.toBeInstanceOf(Forbidden); // diretoria de OUTRA empresa
  });

  it("importa: guarda CIFRADO, descarta a senha, audita sem segredo e libera o checklist", async () => {
    const r = await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW });
    expect(r.replaced).toBe(false); expect(r.daysLeft).toBeGreaterThan(100); expect(r.expiringSoon).toBe(false);
    const raw = JSON.stringify(await db.execute(sql`select * from company_certificates`));
    expect(raw).not.toContain(PW); expect(raw).not.toContain("BEGIN"); expect(raw).toContain('"v1.');
    const [row] = await db.select().from(schema.companyCertificates);
    expect(row.certEnc).toMatch(/^v1\./); expect(row.keyEnc).toMatch(/^v1\./); expect(row.status).toBe("ativo");
    const aud = JSON.stringify(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "nfse.certificate_imported")));
    expect(aud).toContain(row.fingerprint.slice(0, 12)); expect(aud).not.toContain(PW); expect(aud).not.toContain(row.fingerprint);
    const st = await getCertificateStatus(db, dirA, A);
    expect(st.active).toMatchObject({ holderCnpj: CNPJ, subject: `EMPRESA TESTE LTDA:${CNPJ}` });
    expect(JSON.stringify(st)).not.toMatch(/BEGIN|v1\./);
    expect(await hasNfseCertificate(db, dirA, A)).toBe(true);
    expect((await verifyCertificate(db, dirA, A)).ok).toBe(true);
    const s = (await readNfseCertificate(db, A))!;
    expect(s.keyPem).toContain("PRIVATE KEY"); expect(s.fingerprint).toBe(row.fingerprint);
  });

  it("recusa: senha errada, CNPJ de outra empresa, empresa sem CNPJ; nada é gravado", async () => {
    await expect(importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: "errada" })).rejects.toThrow(/Senha do certificado incorreta/);
    await expect(importCertificate(db, dirA, A, { pfx: makePfx({ password: PW, cn: "OUTRA:45723174000110" }), password: PW })).rejects.toThrow(/não é o desta empresa/);
    await expect(importCertificate(db, dirN, noCnpj, { pfx: makePfx({ password: PW }), password: PW })).rejects.toBeInstanceOf(Invalid);
    expect((await db.select().from(schema.companyCertificates)).length).toBe(0);
  });

  it("isolamento: o certificado de uma empresa não aparece na outra", async () => {
    await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW });
    expect((await getCertificateStatus(db, dirB, B)).active).toBeNull();
    expect(await readNfseCertificate(db, B)).toBeNull();
    await expect(importCertificate(db, dirB, B, { pfx: makePfx({ password: PW }), password: PW })).rejects.toThrow(/não é o desta empresa/); // certificado do CNPJ de A
  });

  it("substituir APAGA os segredos do anterior (fica só o histórico público) e mantém um único ativo", async () => {
    await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW });
    const r = await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW });
    expect(r.replaced).toBe(true);
    const rows = await db.select().from(schema.companyCertificates);
    expect(rows.filter((x) => x.status === "ativo")).toHaveLength(1);
    const old = rows.find((x) => x.status === "substituido")!;
    expect(old.certEnc).toBeNull(); expect(old.keyEnc).toBeNull(); expect(old.chainEnc).toBeNull(); expect(old.closedBy).toBe(dirA);
    expect((await getCertificateStatus(db, dirA, A)).history).toHaveLength(1);
  });

  it("remover apaga certificado e chave; remover de novo é recusado", async () => {
    await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW });
    await removeCertificate(db, dirA, A);
    expect(await hasNfseCertificate(db, dirA, A)).toBe(false);
    const [row] = await db.select().from(schema.companyCertificates);
    expect(row).toMatchObject({ status: "removido", certEnc: null, keyEnc: null });
    await expect(removeCertificate(db, dirA, A)).rejects.toBeInstanceOf(Invalid);
    expect((await verifyCertificate(db, dirA, A)).ok).toBe(false);
    expect(await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "nfse.certificate_removed"))).toHaveLength(1);
  });

  it("alerta de vencimento próximo e conferência detecta dado adulterado", async () => {
    const soon = await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW, notAfter: new Date(Date.now() + 10 * 86_400_000) }), password: PW });
    expect(soon.expiringSoon).toBe(true);
    expect((await verifyCertificate(db, dirA, A)).message).toMatch(/Atenção: vence em/);
    await db.execute(sql`update company_certificates set cert_enc = 'v1.AAAA.AAAA.AAAA' where status = 'ativo'`);
    const v = await verifyCertificate(db, dirA, A);
    expect(v.ok).toBe(false); expect(v.message).toMatch(/não conseguiu abrir/);
  });

  it("limita as tentativas de importação por usuário (10 por 10 min)", async () => {
    for (let i = 0; i < 10; i++) await expect(importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: "errada" })).rejects.toThrow(/Senha do certificado incorreta/);
    await expect(importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW })).rejects.toThrow(/Muitas tentativas/);
    expect((await db.select().from(schema.companyCertificates)).length).toBe(0);
  });

  it("o banco recusa segredo em texto puro, nulo em linha ativa e segredo em linha fechada", async () => {
    await importCertificate(db, dirA, A, { pfx: makePfx({ password: PW }), password: PW });
    await expect(db.execute(sql`update company_certificates set cert_enc = null where status = 'ativo'`)).rejects.toThrow();
    await expect(db.execute(sql`update company_certificates set key_enc = null where status = 'ativo'`)).rejects.toThrow();
    await expect(db.execute(sql`update company_certificates set key_enc = '-----BEGIN PRIVATE KEY-----' where status = 'ativo'`)).rejects.toThrow();
    await expect(db.execute(sql`update company_certificates set status = 'removido' where status = 'ativo'`)).rejects.toThrow(); // fechar sem apagar os segredos
  });
});

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
describe("segredos do certificado em claro (guarda)", () => {
  it("só certificate.ts importa cert-secrets", () => {
    const offenders = walk("src").filter((f) => !f.endsWith("cert-secrets.ts") && /cert-secrets/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
    expect(offenders).toEqual(["src/modules/nfse/certificate.ts"]);
  });
  it("componentes de navegador nunca importam o cofre, o certificado nem a biblioteca de .pfx", () => {
    for (const f of walk("src").filter((x) => /^["']use client["']/.test(readFileSync(x, "utf8")))) expect(readFileSync(f, "utf8")).not.toMatch(/cert-secrets|nfse\/certificate|node-forge|secretbox/);
  });
  it("a senha nunca vai para log nem para o banco: nenhum console/audit com `password` nos módulos do certificado", () => {
    const t = readFileSync("src/modules/nfse/certificate.ts", "utf8");
    expect(t).not.toMatch(/console\.(log|error|warn)/);
    expect(t).not.toMatch(/audit\([^)]*password/);
  });
});
