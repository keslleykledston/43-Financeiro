import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden } from "@/modules/identity/service";
import { getEmailStatus, hasEmailAccount, removeEmailAccount, saveEmailAccount } from "@/modules/providers/email-config";
import { readEmailCredentials } from "@/modules/providers/email-secrets";
import { parseHost, parsePort, parseSecurity, parseFromName, parseEmailAddress } from "@/modules/providers/email";
import { fiscalPending, getFiscalProfile, nfseProfileComplete, parseFiscal, updateFiscalProfile } from "@/modules/companies/fiscal";
import { readiness } from "@/modules/providers/readiness";

const enabled = !!process.env.POSTGRES_USER;
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
const mail = (o: Record<string, unknown> = {}) => ({ host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G Solutions — Financeiro", replyTo: "", user: "financeiro@k3gsolutions.com.br", password: "S3nha-Super-Secreta!", ...o });
const fiscalFull = (o: Record<string, unknown> = {}) => ({ taxRegime: "simples", municipalRegistration: "123456", cnae: "6190-601", serviceCode: "1.07", issRate: "2,5", cityName: "Manaus", cityIbge: "1302603", uf: "am", cep: "69000-000", street: "Av. Exemplo", streetNumber: "100", district: "Centro", accountantName: "Contabil Exemplo", accountantDocument: "11.222.333/0001-81", accountantEmail: "Contato@Contabil.com.br", accountantPhone: "(92) 99999-0000", ...o });

describe("E22 — parsers de e-mail (puros)", () => {
  it("servidor: só nome público; porta e segurança coerentes", () => {
    expect(parseHost("  SMTP.K3GSolutions.com.br. ")).toBe("smtp.k3gsolutions.com.br");
    for (const bad of ["", "localhost", "192.168.0.10", "10.0.0.1", "smtp", "smtp.interno.local", "http://smtp.x.com", "smtp.x.com:587", "a b.com", "mail.corp", "[::1]"]) expect(() => parseHost(bad), bad).toThrow();
    expect(parsePort("465")).toBe(465); expect(() => parsePort("22")).toThrow(/Porta inválida/); expect(() => parsePort("abc")).toThrow();
    expect(parseSecurity("ssl", 465)).toBe("ssl"); expect(parseSecurity("starttls", 587)).toBe("starttls");
    expect(() => parseSecurity("ssl", 587)).toThrow(/porta 465/); expect(() => parseSecurity("starttls", 465)).toThrow(); expect(() => parseSecurity("none", 25)).toThrow();
  });
  it("remetente: sem injeção de cabeçalho", () => {
    expect(parseFromName("K3G — Financeiro")).toBe("K3G — Financeiro");
    for (const bad of ["a\r\nBcc: x@y.com", 'Fulano "x"', "a<b>", "x@y"]) expect(() => parseFromName(bad), bad).toThrow();
    expect(parseEmailAddress("Fin@K3G.com.br", "o e-mail")).toBe("fin@k3g.com.br");
    expect(() => parseEmailAddress("sem-arroba", "o e-mail")).toThrow(/inválido/); expect(() => parseEmailAddress("a@b.com\nBcc: x@y.com", "o e-mail")).toThrow();
    expect(parseEmailAddress("", "o e-mail", false)).toBeNull();
  });
});

describe("E22 — dados fiscais (puros)", () => {
  it("normaliza e valida", () => {
    const v = parseFiscal(fiscalFull());
    expect(v).toMatchObject({ taxRegime: "simples", cnae: "6190601", cityIbge: "1302603", uf: "AM", cep: "69000000", issRateBps: 250, serviceCode: "1.07", accountantDocument: "11222333000181", accountantEmail: "contato@contabil.com.br" });
    const bad = (o: Record<string, unknown>, re: RegExp) => expect(() => parseFiscal(fiscalFull(o))).toThrow(re);
    bad({ cnae: "123" }, /CNAE deve ter 7/); bad({ cnae: "61a90601" }, /só números/); bad({ cep: "6900x000" }, /só números/); bad({ cep: "123" }, /CEP deve ter 8/); bad({ cityIbge: "12" }, /IBGE/); bad({ uf: "AMA" }, /máximo 2|UF inválida/); bad({ issRate: "7" }, /Alíquota/); bad({ serviceCode: "107" }, /LC 116/);
    bad({ accountantDocument: "111.111.111-11" }, /inválido/); bad({ accountantEmail: "x" }, /E-mail do contador/); bad({ taxRegime: "outro" }, /Regime/);
    expect(parseFiscal({ issRate: "0" }).issRateBps).toBe(0);
  });
  it("pendências: tudo vazio lista tudo; completo não lista nada", () => {
    expect(fiscalPending(parseFiscal({})).nfse).toContain("CNAE");
    expect(fiscalPending(parseFiscal({})).accounting).toEqual(["contador: nome", "contador: e-mail", "contador: telefone"]);
    expect(fiscalPending(parseFiscal(fiscalFull()))).toEqual({ nfse: [], accounting: [] });
  });
  it("portão: smtp e dados fiscais refletem o que está cadastrado", () => {
    const r = (o: { emailInDb?: boolean; fiscalComplete?: boolean }) => Object.fromEntries(readiness({}, o).map((x) => [x.key, x.state]));
    expect(r({})["smtp-creds"]).toBe("pendente"); expect(r({ emailInDb: true })["smtp-creds"]).toBe("ok");
    expect(r({})["fiscal-profile"]).toBe("pendente"); expect(r({ fiscalComplete: true })["fiscal-profile"]).toBe("ok");
  });
});

describe.skipIf(!enabled)("E22 — conta de e-mail e dados fiscais (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, techA: string;
  beforeAll(async () => {
    process.env.K3G_CREDENTIALS_KEY = "k".repeat(40);
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });
  beforeEach(async () => {
    await db.execute(sql`truncate email_accounts, company_fiscal, provider_credentials, audit_log, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: techA, companyId: A, role: "admin_tecnico" }]);
  });

  it("e-mail: só diretoria; usuário e senha cifrados e nunca em texto; status não os devolve", async () => {
    for (const u of [gerA, techA]) { await expect(saveEmailAccount(db, u, A, mail())).rejects.toBeInstanceOf(Forbidden); await expect(getEmailStatus(db, u, A)).rejects.toBeInstanceOf(Forbidden); }
    await expect(saveEmailAccount(db, dirB, A, mail())).rejects.toBeInstanceOf(Forbidden); // diretoria de outra empresa
    expect(await getEmailStatus(db, dirA, A)).toEqual({ configured: false });
    await saveEmailAccount(db, dirA, A, mail());
    const st = await getEmailStatus(db, dirA, A);
    expect(st).toMatchObject({ configured: true, host: "smtp.k3gsolutions.com.br", port: 587, security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br" });
    expect(JSON.stringify(st)).not.toMatch(/S3nha|userEnc|passEnc/);
    const [raw] = await db.select().from(schema.emailAccounts);
    expect(raw.userEnc).toMatch(/^v1\./); expect(raw.passEnc).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toContain("S3nha-Super-Secreta"); expect(JSON.stringify(raw)).not.toContain("financeiro@k3gsolutions.com.br\",\"passEnc"); // senha nunca em claro
    expect(await readEmailCredentials(db, A)).toMatchObject({ user: "financeiro@k3gsolutions.com.br", password: "S3nha-Super-Secreta!", host: "smtp.k3gsolutions.com.br" });
    expect(await readEmailCredentials(db, B)).toBeNull();
    expect(await hasEmailAccount(db, dirA, A)).toBe(true); expect(await hasEmailAccount(db, dirB, B)).toBe(false);
  });

  it("e-mail: usuário/senha em branco mantêm os atuais; primeira vez exige; valores inválidos recusados; auditoria sem segredo", async () => {
    await expect(saveEmailAccount(db, dirA, A, mail({ user: "", password: "" }))).rejects.toThrow(/usuário e a senha/);
    await saveEmailAccount(db, dirA, A, mail());
    await saveEmailAccount(db, dirA, A, mail({ fromName: "Novo Nome", user: "", password: "" }));
    expect(await readEmailCredentials(db, A)).toMatchObject({ fromName: "Novo Nome", password: "S3nha-Super-Secreta!" });
    await saveEmailAccount(db, dirA, A, mail({ port: "465", security: "ssl", user: "", password: "outra-senha" }));
    expect(await readEmailCredentials(db, A)).toMatchObject({ port: 465, security: "ssl", password: "outra-senha", user: "financeiro@k3gsolutions.com.br" });
    await expect(saveEmailAccount(db, dirA, A, mail({ host: "10.0.0.5" }))).rejects.toThrow(/nome público/);
    await expect(saveEmailAccount(db, dirA, A, mail({ port: "587", security: "ssl" }))).rejects.toThrow(/porta 465/);
    await expect(saveEmailAccount(db, dirA, A, mail({ fromEmail: "x" }))).rejects.toThrow(/inválido/);
    await expect(saveEmailAccount(db, dirA, A, mail({ password: "a\r\nb" }))).rejects.toThrow(/Senha SMTP inválida/);
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "provider.email_saved"));
    expect(log).toHaveLength(3); expect(JSON.stringify(log)).not.toMatch(/S3nha|outra-senha|financeiro@/);
  });

  it("e-mail: a chave do cofre amarra o segredo à empresa; remover apaga; o banco recusa texto puro", async () => {
    await saveEmailAccount(db, dirA, A, mail());
    await saveEmailAccount(db, dirB, B, mail({ user: "b@k3g.com.br", password: "senha-b" }));
    const [ra] = await db.select().from(schema.emailAccounts).where(eq(schema.emailAccounts.companyId, A));
    await db.execute(sql`update email_accounts set pass_enc = ${ra.passEnc} where company_id = ${B}`); // copia o segredo de A para a linha de B
    await expect(readEmailCredentials(db, B)).rejects.toThrow(/ilegível/);
    await expect(db.execute(sql`update email_accounts set pass_enc = 'texto-puro' where company_id = ${A}`).catch((e) => { throw new Error(why(e)); })).rejects.toThrow(/email_accounts_sealed_chk/);
    await removeEmailAccount(db, dirA, A);
    expect(await getEmailStatus(db, dirA, A)).toEqual({ configured: false });
    await expect(removeEmailAccount(db, dirA, A)).rejects.toThrow(/Não há conta/);
  });

  it("fiscal: só diretoria; salva, normaliza e audita só os nomes dos campos; sem mudança não gera evento", async () => {
    for (const u of [gerA, techA]) { await expect(getFiscalProfile(db, u, A)).rejects.toBeInstanceOf(Forbidden); await expect(updateFiscalProfile(db, u, A, fiscalFull())).rejects.toBeInstanceOf(Forbidden); }
    await expect(getFiscalProfile(db, dirB, A)).rejects.toBeInstanceOf(Forbidden);
    expect(await nfseProfileComplete(db, dirA, A)).toBe(false);
    const r = await updateFiscalProfile(db, dirA, A, fiscalFull());
    expect(r.changed).toContain("CNAE"); expect(r.changed).toContain("contador: nome");
    expect(await nfseProfileComplete(db, dirA, A)).toBe(true);
    const p = await getFiscalProfile(db, dirA, A);
    expect(p).toMatchObject({ taxRegime: "simples", cnae: "6190601", issRateBps: 250, uf: "AM", issWithheld: false });
    expect((await getFiscalProfile(db, dirB, B)).cnae).toBeNull(); // isolamento
    expect((await updateFiscalProfile(db, dirA, A, fiscalFull())).changed).toEqual([]);
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "company.fiscal_updated"));
    expect(log).toHaveLength(1); expect(JSON.stringify(log)).not.toMatch(/6190601|Contabil|123456|contato@/i);
    await updateFiscalProfile(db, dirA, A, fiscalFull({ issWithheld: true, cnae: "" }));
    const p2 = await getFiscalProfile(db, dirA, A);
    expect(p2.issWithheld).toBe(true); expect(p2.cnae).toBeNull();
    expect(await nfseProfileComplete(db, dirA, A)).toBe(false);
  });

  it("fiscal: o banco recusa formatos inválidos", async () => {
    await updateFiscalProfile(db, dirA, A, fiscalFull());
    for (const [col, val, re] of [["cnae", "12", /formats_chk/], ["tax_regime", "x", /regime_chk/], ["iss_rate_bps", "900", /iss_chk/], ["uf", "am", /formats_chk/]] as const)
      await expect(db.execute(sql.raw(`update company_fiscal set ${col} = '${val}' where company_id = '${A}'`)).catch((e) => { throw new Error(why(e)); })).rejects.toThrow(re);
  });
});
