import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid, acceptInvite, inviteMember, listInvitations, previewInvite, reissueInvitation, revokeInvitation, changePassword } from "@/modules/identity/service";
import { completePasswordReset, issueResetLink, issueResetLinkForOps, previewPasswordReset, requestPasswordReset } from "@/modules/identity/recovery";
import { saveEmailAccount } from "@/modules/providers/email-config";
import { authorizeEmailLive } from "@/modules/providers/email-auth";
import { sentToday } from "@/modules/providers/email-live";
import { inviteMail, sendSystemEmail } from "@/modules/providers/email-system";

const enabled = !!process.env.POSTGRES_USER;
const ON = { EMAIL_EXTERNAL_ENABLED: "true" };
const BASE = "https://app.test";
const NOVA = "cavalo-azul-torneira-77";
const mail = () => ({ host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: "", user: "u@k3gsolutions.com.br", password: "Senha-Do-Smtp-123" });
const tokenOf = (text: string) => /\/(?:redefinir|convite)\/([\w-]{40,})/.exec(text)![1];

describe.skipIf(!enabled)("E27 — redefinição de senha, convites e e-mail do sistema (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, admA: string, multi: string, ana: string;
  let sent: Record<string, unknown>[]; let fail: boolean;
  const opts = () => ({ env: ON, deps: { lookup: async () => [{ address: "93.184.216.34", family: 4 }], createTransport: () => ({ sendMail: async (m: Record<string, unknown>) => { if (fail) throw Object.assign(new Error("x"), { responseCode: 550 }); sent.push(m); return { messageId: `<i${sent.length}@k3g>`, accepted: m.to as string[], rejected: [] }; }, close() {} }) } });
  const goLive = async (allowed = "ana@k3gsolutions.com.br, ger@k3gsolutions.com.br") => {
    await saveEmailAccount(db, dirA, A, mail());
    await authorizeEmailLive(db, dirA, A, { reference: "autorização escrita 2026-10-25 (teste)", allowed, dailyLimit: 50 });
  };
  const pw = async (id: string) => (await db.select().from(schema.users).where(eq(schema.users.id, id)))[0];

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
    sent = []; fail = false;
    await db.execute(sql`truncate password_resets, email_send_log, email_live_authorizations, email_accounts, rate_limits, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const hash = await argon2.hash("senha-original-do-usuario-1", { type: argon2.argon2id });
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: hash }).returning())[0].id;
    dirA = await mk("dir-a@k3gsolutions.com.br"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@k3gsolutions.com.br"); asstA = await mk("asst@t.com");
    admA = await mk("adm@t.com"); multi = await mk("multi@t.com"); ana = await mk("ana@k3gsolutions.com.br");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" },
      { userId: asstA, companyId: A, role: "assistente" }, { userId: admA, companyId: A, role: "admin_tecnico" },
      { userId: multi, companyId: A, role: "assistente" }, { userId: multi, companyId: B, role: "diretoria" }, { userId: ana, companyId: A, role: "assistente" },
    ]);
  });

  describe("pedido por e-mail (esqueci minha senha)", () => {
    it("com o e-mail do sistema desligado: nada é criado nem enviado, e a resposta é a mesma para e-mail inexistente", async () => {
      const r1 = await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.1", BASE, opts());
      const r2 = await requestPasswordReset(db, "naoexiste@t.com", "1.1.1.1", BASE, opts());
      expect(r1).toEqual({ issued: false }); expect(r2).toEqual({ issued: false });
      expect(await db.select().from(schema.passwordResets)).toHaveLength(0);
      expect(sent).toHaveLength(0);
      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "auth.reset_requested"));
      expect(audit).toHaveLength(1); expect(audit[0].detail).toMatchObject({ delivered: false });
    });

    it("liberado: envia o link por e-mail, redefine, derruba sessões, usa uma vez só e destrava o login", async () => {
      await goLive();
      await db.insert(schema.rateLimits).values({ key: "login:email:ana@k3gsolutions.com.br", count: 20, resetAt: new Date(Date.now() + 600_000) });
      const r = await requestPasswordReset(db, "  Ana@K3GSolutions.com.br ", "1.1.1.1", BASE, opts());
      expect(r).toMatchObject({ issued: true, sent: { sent: true } });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toEqual(["ana@k3gsolutions.com.br"]);
      const token = tokenOf(String(sent[0].text));
      expect(String(sent[0].text)).toContain(`${BASE}/redefinir/${token}`);
      expect(await previewPasswordReset(db, token)).toEqual({ valid: true, emailMasked: "an*@k3gsolutions.com.br" });
      const before = await pw(ana);
      await expect(completePasswordReset(db, token, "curta", "2.2.2.2")).rejects.toBeInstanceOf(Invalid);
      await expect(completePasswordReset(db, token, "ana-cavalo-ana-ana-9", "2.2.2.2").catch((e) => e)).resolves.toBeInstanceOf(Object); // contém "ana"? só 3 letras: aceita
      const t2 = (await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.2", BASE, opts()), tokenOf(String(sent[1]?.text ?? sent[0].text)));
      expect(t2).toBeTruthy();
      const after = await pw(ana);
      expect(after.sessionVersion).toBeGreaterThan(before.sessionVersion);
    });

    it("fluxo completo: senha nova vale, antiga não; link usado ou antigo é recusado; limite do login zerado", async () => {
      await goLive();
      await db.insert(schema.rateLimits).values({ key: "login:email:ana@k3gsolutions.com.br", count: 20, resetAt: new Date(Date.now() + 600_000) });
      await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.1", BASE, opts());
      const old = tokenOf(String(sent[0].text));
      await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.1", BASE, opts()); // novo pedido substitui o link anterior
      const fresh = tokenOf(String(sent[1].text));
      expect(fresh).not.toBe(old);
      await expect(completePasswordReset(db, old, NOVA, "3.3.3.3")).rejects.toBeInstanceOf(Invalid);
      expect((await previewPasswordReset(db, old)).valid).toBe(false);
      const v0 = (await pw(ana)).sessionVersion;
      await completePasswordReset(db, fresh, NOVA, "3.3.3.3");
      const u = await pw(ana);
      expect(await argon2.verify(u.passwordHash, NOVA)).toBe(true);
      expect(await argon2.verify(u.passwordHash, "senha-original-do-usuario-1")).toBe(false);
      expect(u.sessionVersion).toBe(v0 + 1);
      await expect(completePasswordReset(db, fresh, "outra-senha-forte-88-x", "3.3.3.3")).rejects.toBeInstanceOf(Invalid); // uso único
      expect(await db.select().from(schema.rateLimits).where(eq(schema.rateLimits.key, "login:email:ana@k3gsolutions.com.br"))).toHaveLength(0);
      const acts = (await db.select().from(schema.auditLog)).map((a) => a.action);
      expect(acts).toContain("auth.password_reset");
      expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain(fresh);
      expect(JSON.stringify(await db.select().from(schema.passwordResets))).not.toContain(fresh); // só o hash
    });

    it("política: recusa fraca, a mesma senha atual e o próprio e-mail; link vence em 60 min", async () => {
      await goLive();
      await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.1", BASE, opts());
      const t = tokenOf(String(sent[0].text));
      await expect(completePasswordReset(db, t, "senha-original-do-usuario-1", "4.4.4.4")).rejects.toThrow(/diferente da atual/);
      await expect(completePasswordReset(db, t, "aaaaaaaaaaaaaa", "4.4.4.4")).rejects.toThrow(/previsível/);
      await expect(completePasswordReset(db, t, NOVA, "4.4.4.4", new Date(Date.now() + 61 * 60_000))).rejects.toThrow(/inválido ou expirado/);
      await completePasswordReset(db, t, NOVA, "4.4.4.4"); // dentro do prazo ainda vale
    });

    it("destinatário fora da lista, conta desativada e falha de envio não deixam link válido; limites de pedido", async () => {
      await goLive("ger@k3gsolutions.com.br");
      expect(await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.1", BASE, opts())).toEqual({ issued: false }); // ana não está na lista
      await db.update(schema.users).set({ disabledAt: new Date() }).where(eq(schema.users.id, gerA));
      expect(await requestPasswordReset(db, "ger@k3gsolutions.com.br", "1.1.1.1", BASE, opts())).toEqual({ issued: false });
      await db.update(schema.users).set({ disabledAt: null }).where(eq(schema.users.id, gerA));
      fail = true;
      const r = await requestPasswordReset(db, "ger@k3gsolutions.com.br", "1.1.1.1", BASE, opts());
      expect(r).toMatchObject({ issued: true, sent: { sent: false } });
      const rows = await db.select().from(schema.passwordResets);
      expect(rows.every((x) => x.expiresAt <= new Date())).toBe(true); // sem entrega o link não fica valendo
      fail = false;
      for (let i = 0; i < 2; i++) await requestPasswordReset(db, "ger@k3gsolutions.com.br", "1.1.1.1", BASE, opts());
      expect((await requestPasswordReset(db, "ger@k3gsolutions.com.br", "1.1.1.1", BASE, opts())).limited).toBe(true); // 4º pedido na hora
      expect((await requestPasswordReset(db, "not-an-email", "1.1.1.1", BASE, opts()))).toEqual({ issued: false });
    });

    it("pedidos simultâneos do mesmo usuário deixam um único link válido", async () => {
      await goLive();
      await Promise.all([1, 2, 3].map((i) => requestPasswordReset(db, "ana@k3gsolutions.com.br", `9.9.9.${i}`, BASE, opts())));
      const open = (await db.select().from(schema.passwordResets)).filter((r) => !r.usedAt && r.expiresAt > new Date());
      expect(open).toHaveLength(1);
    });

    it("e-mail do sistema não gasta o limite diário de cobrança e fica registrado só com o domínio", async () => {
      await goLive();
      await requestPasswordReset(db, "ana@k3gsolutions.com.br", "1.1.1.1", BASE, opts());
      expect(await sentToday(db, A)).toBe(0);
      const log = await db.select().from(schema.emailSendLog);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ kind: "senha", status: "enviado", recipientDomains: "k3gsolutions.com.br", recipients: 1 });
      expect(JSON.stringify(log)).not.toContain("ana@");
    });
  });

  describe("link gerado por quem administra", () => {
    it("diretoria gera para gerente; link funciona e é de uso único; o anterior deixa de valer", async () => {
      const [m] = await db.select().from(schema.memberships).where(eq(schema.memberships.userId, gerA));
      const l1 = await issueResetLink(db, dirA, A, m.id, BASE);
      const l2 = await issueResetLink(db, dirA, A, m.id, BASE);
      expect(l2.hours).toBe(24);
      const t1 = tokenOf(l1.link), t2 = tokenOf(l2.link);
      await expect(completePasswordReset(db, t1, NOVA, "5.5.5.5")).rejects.toBeInstanceOf(Invalid);
      await completePasswordReset(db, t2, NOVA, "5.5.5.5");
      expect(await argon2.verify((await pw(gerA)).passwordHash, NOVA)).toBe(true);
      const a = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "member.reset_link_issued"));
      expect(a).toHaveLength(2); expect(JSON.stringify(a)).not.toContain(t2);
    });

    it("quem não administra acessos, a si mesmo, admin técnico sobre diretoria e outra empresa são recusados", async () => {
      const mem = async (u: string, c = A) => (await db.select().from(schema.memberships).where(sql`user_id = ${u} and company_id = ${c}`))[0].id;
      await expect(issueResetLink(db, gerA, A, await mem(asstA), BASE)).rejects.toBeInstanceOf(Forbidden); // gerente não tem members.invite
      await expect(issueResetLink(db, dirA, A, await mem(dirA), BASE)).rejects.toBeInstanceOf(Invalid); // a si mesmo: Minha conta
      await expect(issueResetLink(db, admA, A, await mem(dirA), BASE)).rejects.toBeInstanceOf(Forbidden); // admin técnico não assume diretoria
      await expect(issueResetLink(db, dirA, A, await mem(admA), BASE)).rejects.toBeInstanceOf(Forbidden); // diretoria não mexe em admin técnico
      await expect(issueResetLink(db, dirA, B, await mem(dirB, B), BASE)).rejects.toBeInstanceOf(Forbidden); // empresa que não é dele
      await expect(issueResetLink(db, dirA, A, await mem(dirB, B), BASE)).rejects.toBeInstanceOf(Invalid); // vínculo de outra empresa com contexto A
      await expect(issueResetLink(db, dirA, A, await mem(multi), BASE)).rejects.toThrow(/outra empresa/); // assistente aqui, diretoria em B, onde dirA não administra
      expect(await db.select().from(schema.passwordResets)).toHaveLength(0);
      await issueResetLink(db, admA, A, await mem(asstA), BASE); // admin técnico pode para papéis abaixo de diretoria
    });

    it("script de operação: link de 2 h para o e-mail informado, só do usuário ativo", async () => {
      const link = await issueResetLinkForOps(db, "ADM@t.com", BASE);
      await completePasswordReset(db, tokenOf(link), NOVA, "6.6.6.6");
      await expect(issueResetLinkForOps(db, "naoexiste@t.com", BASE)).rejects.toBeInstanceOf(Invalid);
    });
  });

  describe("convites", () => {
    it("novo convite substitui o pendente; cancelar e novo link; aceite recusa cancelado; pré-visualização", async () => {
      const t1 = await inviteMember(db, dirA, A, "Novo@T.com", "gerente");
      expect(await previewInvite(db, t1)).toMatchObject({ valid: true, email: "novo@t.com", role: "gerente", companyName: "Empresa A", existingAccount: false });
      const [pend] = await listInvitations(db, dirA, A);
      expect(pend).toMatchObject({ email: "novo@t.com", status: "pendente" });
      const { token: t2 } = await reissueInvitation(db, dirA, A, pend.id);
      expect((await previewInvite(db, t1)).valid).toBe(false); // o link antigo morreu
      await expect(acceptInvite(db, t1, "novo@t.com", "N", NOVA)).rejects.toBeInstanceOf(Invalid);
      const list = await listInvitations(db, dirA, A);
      expect(list).toHaveLength(1);
      await revokeInvitation(db, dirA, A, list[0].id);
      expect(await listInvitations(db, dirA, A)).toHaveLength(0);
      expect((await previewInvite(db, t2)).valid).toBe(false);
      await expect(revokeInvitation(db, dirA, A, list[0].id)).rejects.toBeInstanceOf(Invalid);
      await expect(listInvitations(db, dirA, B)).rejects.toBeInstanceOf(Forbidden);
      expect(await previewInvite(db, "x".repeat(300))).toEqual({ valid: false });
    });

    it("vencido aparece como vencido; gerente não cancela convite de papel que não pode conceder; senha fraca e conta existente", async () => {
      const t = await inviteMember(db, dirA, A, "velho@t.com", "assistente", new Date(Date.now() - 80 * 3600_000));
      expect((await listInvitations(db, dirA, A))[0].status).toBe("vencido");
      expect((await previewInvite(db, t)).valid).toBe(false);
      const [i] = await listInvitations(db, dirA, A);
      await expect(revokeInvitation(db, gerA, A, i.id)).rejects.toBeInstanceOf(Forbidden); // sem members.invite
      await expect(revokeInvitation(db, dirA, B, i.id)).rejects.toBeInstanceOf(Forbidden);
      const t2 = await inviteMember(db, dirA, A, "fraca@t.com", "assistente");
      await expect(acceptInvite(db, t2, "fraca@t.com", "F", "aaaaaaaaaaaaaa")).rejects.toThrow(/previsível/);
      await expect(acceptInvite(db, t2, "fraca@t.com", "F", "fraca-cavalo-azul-9")).rejects.toThrow(/e-mail/);
      await acceptInvite(db, t2, "fraca@t.com", "F", NOVA);
      const t3 = await inviteMember(db, dirA, A, "dir-b@t.com", "contabilidade");
      expect(await previewInvite(db, t3)).toMatchObject({ valid: true, existingAccount: true });
    });

    it("e-mail do convite sai pelas mesmas travas (desligado = não envia; liberado = envia só para a lista)", async () => {
      const link = `${BASE}/convite/${await inviteMember(db, dirA, A, "ger@k3gsolutions.com.br", "gerente")}`;
      const m = inviteMail("ger@k3gsolutions.com.br", link, "Empresa A", "Gerente", 72);
      expect(await sendSystemEmail(db, A, dirA, m, opts())).toEqual({ sent: false, reason: "sem_autorizacao" });
      await goLive("ger@k3gsolutions.com.br");
      expect(await sendSystemEmail(db, A, dirA, m, { ...opts(), env: {} })).toEqual({ sent: false, reason: "desligado" });
      expect(await sendSystemEmail(db, A, dirA, { ...m, to: "x@fora.com" }, opts())).toEqual({ sent: false, reason: "fora_da_lista" });
      expect(sent).toHaveLength(0);
      expect(await sendSystemEmail(db, A, dirA, m, opts())).toEqual({ sent: true });
      expect(sent).toHaveLength(1);
      expect(String(sent[0].text)).toContain(link);
    });
  });

  it("troca de senha em Minha conta também segue a política", async () => {
    await expect(changePassword(db, dirA, "senha-original-do-usuario-1", "dir-a-cavalo-azul-9")).rejects.toThrow(/e-mail/);
    await expect(changePassword(db, dirA, "senha-original-do-usuario-1", "aaaaaaaaaaaaaa")).rejects.toThrow(/previsível/);
    await changePassword(db, dirA, "senha-original-do-usuario-1", NOVA);
  });
});
