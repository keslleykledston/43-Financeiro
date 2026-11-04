import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { getPanel, setBoletos, setEmail, setEmailLimit, setRegua, setReguaKinds, setSistema, setWhatsapp, setWhatsappLimit } from "@/modules/authorizations/panel";
import { saveEmailAccount } from "@/modules/providers/email-config";
import { authorizeEmailLive, getEmailLiveStatus } from "@/modules/providers/email-auth";

const enabled = !!process.env.POSTGRES_USER;
const ALL = { EMAIL_EXTERNAL_ENABLED: "true", WHATSAPP_MODULE_ENABLED: "true", WHATSAPP_SEND_ENABLED: "true", WHATSAPP_AUTOMATION_ENABLED: "true" };
const mail = () => ({ host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: "", user: "u@k3gsolutions.com.br", password: "Senha-Do-Smtp-123" });

describe.skipIf(!enabled)("A1 — painel único de autorizações (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string;

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
    await db.execute(sql`truncate email_send_log, email_live_authorizations, email_accounts, whatsapp_company_settings, issuance_settings, audit_log, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }]);
  });

  it("tudo nasce desligado; gerente VÊ mas não muda; outra empresa não mexe", async () => {
    const p = await getPanel(db, gerA, A, ALL);
    expect(Object.values(p.rows).map((r) => r.on)).toEqual([false, false, false, false, false]);
    expect(Object.values(p.rows).every((r) => !r.canChange)).toBe(true);
    expect((await getPanel(db, dirA, A, ALL)).rows.email.canChange).toBe(true);
    await expect(setEmail(db, gerA, A, true, {}, ALL)).rejects.toThrow(Forbidden);
    await expect(setWhatsapp(db, gerA, A, true, {}, ALL)).rejects.toThrow(Forbidden);
    await expect(setBoletos(db, gerA, A, true, {}, ALL)).rejects.toThrow(Forbidden);
    await expect(setEmail(db, dirB, A, true, {}, ALL)).rejects.toThrow(Forbidden); // diretoria de B não age em A
  });

  it("e-mail: liga com 1 clique (todos os clientes + limite), exige conta e a chave do servidor, desliga e é idempotente", async () => {
    await expect(setEmail(db, dirA, A, true, {}, ALL)).rejects.toThrow(/Cadastre antes a conta/);
    await saveEmailAccount(db, dirA, A, mail());
    await expect(setEmail(db, dirA, A, true, {}, {})).rejects.toThrow(/desligado neste servidor/);
    await expect(setEmail(db, dirA, A, true, { dailyLimit: 999 }, ALL)).rejects.toThrow(Invalid);
    await setEmail(db, dirA, A, true, { dailyLimit: 30 }, ALL);
    const r = (await getPanel(db, dirA, A, ALL)).rows.email;
    expect(r).toMatchObject({ on: true, detail: { scope: "todos", dailyLimit: 30 } });
    expect((await getEmailLiveStatus(db, dirA, A)).authorization).toMatchObject({ allowed: ["*"], dailyLimit: 30 });
    await setEmail(db, dirA, A, true, { dailyLimit: 40 }, ALL); // salvar o limite = nova autorização no lugar da anterior
    expect((await getPanel(db, dirA, A, ALL)).rows.email.detail.dailyLimit).toBe(40);
    await setEmail(db, dirA, A, false, {}, ALL);
    expect((await getPanel(db, dirA, A, ALL)).rows.email.on).toBe(false);
    await setEmail(db, dirA, A, false, {}, ALL); // desligar de novo não falha
    const au = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "authorization.panel"));
    expect(au.length).toBe(4); expect(JSON.stringify(au)).not.toMatch(/@/);
    expect(JSON.stringify(await db.select().from(schema.emailLiveAuthorizations))).not.toMatch(/dir-a/); // a referência não leva nome de pessoa
  });

  it("«E-mail do sistema» é uma chave própria: exige a conta, só a diretoria liga, não mexe na autorização de clientes e fica auditada", async () => {
    await expect(setSistema(db, dirA, A, true, ALL)).rejects.toThrow(/Cadastre antes a conta/);
    await saveEmailAccount(db, dirA, A, mail());
    await expect(setSistema(db, gerA, A, true, ALL)).rejects.toThrow(Forbidden);
    await expect(setSistema(db, dirB, A, true, ALL)).rejects.toThrow(Forbidden);
    await expect(setSistema(db, dirA, A, true, {})).rejects.toThrow(/desligado neste servidor/);
    await setSistema(db, dirA, A, true, ALL);
    const p = await getPanel(db, dirA, A, ALL);
    expect(p.rows.sistema).toMatchObject({ on: true, canChange: true }); expect(p.rows.email.on).toBe(false); // clientes continua desligado
    expect(await getEmailLiveStatus(db, dirA, A).then((s) => s.authorization)).toBeNull();
    await setSistema(db, dirA, A, true, ALL); // ligar de novo não duplica
    await setSistema(db, dirA, A, false, ALL);
    expect((await getPanel(db, dirA, A, ALL)).rows.sistema.on).toBe(false);
    const au = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "authorization.panel"))).filter((r) => (r.detail as { function?: string }).function === "sistema");
    expect(au).toHaveLength(2);
  });

  it("salvar limite/réguas NUNCA liga nem amplia: exige a função ligada e preserva a lista de destinatários", async () => {
    await expect(setEmailLimit(db, dirA, A, 10, ALL)).rejects.toThrow(/Ligue antes/);
    await expect(setWhatsappLimit(db, dirA, A, 3, ALL)).rejects.toThrow(/Ligue antes/);
    await expect(setReguaKinds(db, dirA, A, ["d0"], ALL)).rejects.toThrow(/Ligue antes/);
    expect((await getPanel(db, dirA, A, ALL)).rows.email.on).toBe(false);
    await expect(setEmailLimit(db, gerA, A, 10, ALL)).rejects.toThrow(Forbidden);
    await saveEmailAccount(db, dirA, A, mail());
    await authorizeEmailLive(db, dirA, A, { reference: "e-mail da diretoria 25/10/2026", allowed: "fin1@k3gsolutions.com.br, @k3gsolutions.com.br", dailyLimit: 5 }); // autorização ANTIGA por lista
    await setEmailLimit(db, dirA, A, 12, ALL);
    expect((await getEmailLiveStatus(db, dirA, A)).authorization).toMatchObject({ allowed: ["fin1@k3gsolutions.com.br", "@k3gsolutions.com.br"], dailyLimit: 12, reference: "e-mail da diretoria 25/10/2026" });
    await setEmail(db, dirA, A, true, {}, ALL); // «ligar» com a lista já ativa não a amplia para «todos»
    expect((await getEmailLiveStatus(db, dirA, A)).authorization!.allowed).toEqual(["fin1@k3gsolutions.com.br", "@k3gsolutions.com.br"]);
    await expect(setEmailLimit(db, dirA, A, 13, {})).rejects.toThrow(/desligado neste servidor/); // chave do servidor desligada: recusa e não muda nada
    expect((await getEmailLiveStatus(db, dirA, A)).authorization!.dailyLimit).toBe(12);
  });

  it("estado efetivo: ligado no painel mas com a chave do servidor desligada aparece como PARADO", async () => {
    await setWhatsapp(db, dirA, A, true, {}, ALL);
    const r = (await getPanel(db, dirA, A, { WHATSAPP_MODULE_ENABLED: "true" })).rows.whatsapp;
    expect(r.on).toBe(true); expect(r.serverOff).toBe(true);
    expect((await getPanel(db, dirA, A, ALL)).rows.whatsapp.serverOff).toBe(false);
  });

  it("WhatsApp e régua: ligar/desligar com 1 clique; a régua depende do WhatsApp e das chaves do servidor", async () => {
    await expect(setWhatsapp(db, dirA, A, true, {}, {})).rejects.toThrow(/desligado neste servidor/);
    await expect(setRegua(db, dirA, A, true, {}, ALL)).rejects.toThrow(/libere a cobrança por WhatsApp/);
    await setWhatsapp(db, dirA, A, true, { dailyCap: 5 }, ALL);
    await expect(setWhatsapp(db, dirA, A, true, { dailyCap: 50 }, ALL)).rejects.toThrow(Invalid);
    await setRegua(db, dirA, A, true, { kinds: ["d0", "d_mais_3"] }, ALL);
    let p = await getPanel(db, dirA, A, ALL);
    expect(p.rows.whatsapp).toMatchObject({ on: true, detail: { dailyCap: 5 } }); expect(p.rows.regua).toMatchObject({ on: true, detail: { kinds: ["d0", "d_mais_3"] } });
    await expect(setRegua(db, dirA, A, true, { kinds: ["xx"] }, ALL)).rejects.toThrow(Invalid);
    await setWhatsapp(db, dirA, A, false, {}, ALL); // desligar o WhatsApp desliga a régua
    p = await getPanel(db, dirA, A, ALL);
    expect(p.rows.whatsapp.on).toBe(false); expect(p.rows.regua.on).toBe(false);
    await setWhatsapp(db, dirA, A, true, {}, ALL);
    await setRegua(db, dirA, A, true, {}, ALL); // sem escolha nova: vale a escolha salva da vez anterior
    expect((await getPanel(db, dirA, A, ALL)).rows.regua.detail.kinds).toEqual(["d0", "d_mais_3"]);
    await db.execute(sql`update whatsapp_company_settings set automation_kinds = '{}', automation_enabled = false`);
    await setRegua(db, dirA, A, true, {}, ALL); // nada salvo e nada escolhido: padrão = no vencimento
    expect((await getPanel(db, dirA, A, ALL)).rows.regua.detail.kinds).toEqual(["d0"]);
    await setRegua(db, dirA, A, false, {}, ALL);
    expect((await getPanel(db, dirA, A, ALL)).rows.regua.on).toBe(false);
  });

  it("boletos reais: sem a chave de produção do servidor não liga; desligar (pausar) é sempre permitido", async () => {
    await expect(setBoletos(db, dirA, A, true, {}, {})).rejects.toThrow(/desligada neste servidor/);
    const p = await getPanel(db, dirA, A, {});
    expect(p.rows.boletos).toMatchObject({ on: false }); expect(p.rows.boletos.blocked).toMatch(/desligada neste servidor/);
    await setBoletos(db, dirA, A, false, {}, {}); // sem configuração: nada a pausar, sem erro
    await db.insert(schema.issuanceSettings).values({ companyId: A, paused: false, dailyLimit: 20, boletoProvider: "simulado" });
    await setBoletos(db, dirA, A, false, {}, {});
    expect((await db.select().from(schema.issuanceSettings))[0].paused).toBe(true);
  });
});
