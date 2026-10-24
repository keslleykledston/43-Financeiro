import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty } from "@/modules/crm/service";
import { createContract, decideVersion, getContract } from "@/modules/contracts/service";
import { approveBatch, generateBatch, getBatch } from "@/modules/billing/batches";
import { ensureDefaultTemplates, listQueue, processQueue, runScheduled, scheduleQueue } from "@/modules/messaging/service";
import { saveEmailAccount, removeEmailAccount } from "@/modules/providers/email-config";
import { authorizeEmailLive, getEmailLiveStatus, revokeEmailLive } from "@/modules/providers/email-auth";
import { emailLiveActive, listSendLog, sendTestEmail } from "@/modules/providers/email-live";

const enabled = !!process.env.POSTGRES_USER;
const D = "2026-10-01"; // emissão: a régua do dia 1 tem o e-mail "emissao" de cada cobrança
const ON = { EMAIL_EXTERNAL_ENABLED: "true" };
const why = (e: unknown) => String((e as { cause?: { message?: string } })?.cause?.message ?? (e as Error)?.message ?? e);
const mail = () => ({ host: "smtp.k3gsolutions.com.br", port: "587", security: "starttls", fromEmail: "financeiro@k3gsolutions.com.br", fromName: "K3G", replyTo: "", user: "u@k3gsolutions.com.br", password: "Senha-Do-Smtp-123" });

describe.skipIf(!enabled)("E23 — envio REAL de e-mail (canário) com transporte simulado (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, asstA: string, cli1: string, cli2: string;
  type Sent = { o: Record<string, unknown>; m: Record<string, unknown> };
  let sent: Sent[]; let behavior: (m: Record<string, unknown>) => Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }>;
  const ok = async (m: Record<string, unknown>) => ({ messageId: `<id${sent.length}@k3g>`, accepted: m.to as string[], rejected: [] });
  const deps = () => ({ env: ON, smtp: { lookup: async () => [{ address: "93.184.216.34", family: 4 }], createTransport: () => ({ sendMail: async (m: Record<string, unknown>) => { sent.push({ o: {}, m }); return behavior(m); }, close() {} }) } });

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
    sent = []; behavior = ok;
    await db.execute(sql`truncate email_send_log, email_live_authorizations, email_accounts, message_queue, message_template_versions, message_templates, charges, billing_batches, holidays, contract_versions, contracts, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "Empresa A" }, { name: "Empresa B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); asstA = await mk("asst@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }, { userId: asstA, companyId: A, role: "assistente" }]);
    cli1 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Um", document: "11.222.333/0001-81" })).id;
    cli2 = (await createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente Dois", document: "12.ABC.345/01DE-35" })).id;
    await db.insert(schema.customerContacts).values([
      { companyId: A, partyId: cli1, name: "Fin Um", email: "fin1@k3gsolutions.com.br", isFinancial: true }, // dentro da lista do canário
      { companyId: A, partyId: cli2, name: "Fin Dois", email: "fin2@cliente-externo.com.br", isFinancial: true }, // fora da lista
    ]);
  });

  const approved = async () => {
    for (const c of [cli1, cli2]) {
      const k = await createContract(db, asstA, A, c, { description: "Monitoramento", monthlyAmount: "2.500,00", startAt: "2026-01-01", endAt: "", dueDay: "14", invoiceJointRequired: false, issueDayOverride: "" });
      await decideVersion(db, dirA, A, (await getContract(db, dirA, A, k.id))!.versions[0].id, "aprovar");
    }
    const { batchId } = await generateBatch(db, asstA, A, D);
    await approveBatch(db, dirA, A, batchId, (await getBatch(db, asstA, A, batchId))!.hash);
    await ensureDefaultTemplates(db, dirA, A);
    await scheduleQueue(db, asstA, A, D);
  };
  const setup = async (limit = 10) => { await saveEmailAccount(db, dirA, A, mail()); await authorizeEmailLive(db, dirA, A, { reference: "e-mail da diretoria 25/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: limit }); await approved(); };
  const emails = async () => (await listQueue(db, dirA, A)).items.filter((i) => i.channel === "email" && i.kind === "emissao");
  const st = async (name: string) => (await emails()).find((i) => i.customerName === name)!;

  it("com a chave desligada, ou ligada sem autorização, continua 100% simulado (nada vai ao transporte)", async () => {
    await saveEmailAccount(db, dirA, A, mail()); await approved();
    await processQueue(db, asstA, A, D, undefined, { env: {}, smtp: deps().smtp });
    expect((await emails()).map((i) => i.status)).toEqual(["simulado", "simulado"]);
    expect(sent).toHaveLength(0);
    await db.execute(sql`update message_queue set status = 'pendente', processed_at = null where channel = 'email'`);
    await processQueue(db, asstA, A, D, undefined, deps()); // chave ligada, sem autorização
    expect((await emails()).map((i) => i.status)).toEqual(["simulado", "simulado"]); expect(sent).toHaveLength(0);
    expect(await emailLiveActive(db, A, ON)).toBe(false); expect(await emailLiveActive(db, A, {})).toBe(false);
  });

  it("real: envia só ao autorizado, bloqueia o resto, registra, e nunca reenvia", async () => {
    await setup();
    expect(await emailLiveActive(db, A, ON)).toBe(true); expect(await emailLiveActive(db, B, ON)).toBe(false);
    const r = await processQueue(db, asstA, A, D, undefined, deps());
    expect(r).toMatchObject({ processed: expect.any(Number), failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].m).toMatchObject({ to: ["fin1@k3gsolutions.com.br"] });
    expect(String(sent[0].m.subject)).toBeTruthy();
    const um = await st("Cliente Um"), dois = await st("Cliente Dois");
    expect(um).toMatchObject({ status: "enviado", attempts: 1, providerRef: "id1@k3g" }); expect(um.renderedBody).toContain("Cliente Um");
    expect(dois).toMatchObject({ status: "bloqueado" }); expect(dois.blockedReason).toMatch(/fora da lista autorizada/);
    const log = await listSendLog(db, dirA, A);
    expect(log).toHaveLength(1); expect(log[0]).toMatchObject({ kind: "fila", status: "enviado", domains: "k3gsolutions.com.br" });
    expect(JSON.stringify(log)).not.toContain("fin1@");
    await processQueue(db, asstA, A, D, undefined, deps()); await processQueue(db, asstA, A, D, undefined, deps());
    expect(sent).toHaveLength(1); // enviado é final
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "messages.email.live_run"));
    expect(audits.length).toBeGreaterThan(0); expect(JSON.stringify(audits)).not.toMatch(/fin1@|Cliente Um/);
  });

  it("falhas: temporária volta à fila; definitiva e resultado desconhecido bloqueiam (nunca reenviam sozinhos)", async () => {
    await setup();
    behavior = async () => { throw Object.assign(new Error("x"), { responseCode: 421 }); };
    await processQueue(db, asstA, A, D, undefined, deps());
    expect(await st("Cliente Um")).toMatchObject({ status: "pendente", attempts: 1, lastError: "smtp_421" });
    behavior = async () => { throw Object.assign(new Error("x"), { responseCode: 550 }); };
    await processQueue(db, asstA, A, D, undefined, deps());
    expect(await st("Cliente Um")).toMatchObject({ status: "bloqueado", attempts: 2 }); expect((await st("Cliente Um")).blockedReason).toMatch(/Falha no envio \(smtp_550\)/);
    await db.execute(sql`update message_queue set status = 'pendente', blocked_reason = null where channel = 'email' and kind = 'emissao' and customer_id = ${cli1}`);
    behavior = async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); };
    await processQueue(db, asstA, A, D, undefined, deps());
    const um = await st("Cliente Um");
    expect(um.status).toBe("bloqueado"); expect(um.blockedReason).toMatch(/PODE ter sido enviado/);
    const before = sent.length;
    behavior = ok; await processQueue(db, asstA, A, D, undefined, deps());
    expect(sent.length).toBe(before); // não reenvia o desconhecido
    expect((await listSendLog(db, dirA, A, 10)).map((l) => l.status).sort()).toEqual(["desconhecido", "falhou", "falhou"]);
  });

  it("limite diário da autorização", async () => {
    await saveEmailAccount(db, dirA, A, mail());
    await authorizeEmailLive(db, dirA, A, { reference: "e-mail da diretoria 25/10/2026", allowed: "@k3gsolutions.com.br, fin2@cliente-externo.com.br", dailyLimit: 1 });
    await approved();
    const r = await processQueue(db, asstA, A, D, undefined, deps());
    expect(sent).toHaveLength(1); expect(r.waiting).toMatch(/Limite/);
    const again = await processQueue(db, asstA, A, D, undefined, deps());
    expect(sent).toHaveLength(1); expect(again.waiting).toMatch(/Limite/);
    await expect(sendTestEmail(db, dirA, A, "x@k3gsolutions.com.br", ON, deps().smtp)).rejects.toThrow(/Limite diário/);
  });

  it("travado em 'enviando' (processo caiu) vira desconhecido e nunca é reenviado", async () => {
    await setup();
    await db.execute(sql`update message_queue set status = 'enviando', updated_at = now() - interval '30 minutes', processed_at = now() where channel = 'email' and kind = 'emissao' and customer_id = ${cli1}`);
    const q = (await emails()).find((i) => i.customerName === "Cliente Um")!;
    await db.insert(schema.emailSendLog).values({ companyId: A, kind: "fila", queueId: q.id, recipientDomains: "k3gsolutions.com.br", recipients: 1 });
    await db.execute(sql`alter table email_send_log disable trigger email_send_log_guard_trg`); await db.execute(sql`update email_send_log set created_at = now() - interval '30 minutes'`); await db.execute(sql`alter table email_send_log enable trigger email_send_log_guard_trg`);
    await processQueue(db, asstA, A, D, undefined, deps());
    expect(await st("Cliente Um")).toMatchObject({ status: "bloqueado" }); expect((await st("Cliente Um")).blockedReason).toMatch(/Resultado desconhecido/);
    expect(sent).toHaveLength(0);
    expect((await listSendLog(db, dirA, A))[0]).toMatchObject({ status: "desconhecido", error: "processo_interrompido" });
  });

  it("bloqueado (conta removida): o e-mail NÃO é consumido nem simulado e a razão aparece", async () => {
    await setup();
    await removeEmailAccount(db, dirA, A);
    const r = await processQueue(db, asstA, A, D, undefined, deps());
    expect(r.waiting).toMatch(/E-mail real bloqueado: Conta de e-mail não cadastrada/);
    expect((await emails()).map((i) => i.status)).toEqual(["pendente", "pendente"]); expect(sent).toHaveLength(0);
  });

  it("revogar volta ao simulado; o banco protege o histórico (sem apagar, sem editar, sem reabrir)", async () => {
    await setup();
    await processQueue(db, asstA, A, D, undefined, deps());
    const um = await st("Cliente Um");
    const f = (q: ReturnType<typeof sql>) => db.execute(q).catch((e) => { throw new Error(why(e)); });
    await expect(f(sql`delete from message_queue where id = ${um.id}`)).rejects.toThrow(/não pode ser apagada/);
    await expect(f(sql`update message_queue set renderedBody = 'x' where id = ${um.id}`)).rejects.toThrow();
    await expect(f(sql`update message_queue set status = 'pendente' where id = ${um.id}`)).rejects.toThrow(/já enviada/);
    await expect(f(sql`delete from charges where id = ${um.chargeId}`)).rejects.toThrow(/não pode ser apagada|violates/);
    await expect(f(sql`delete from email_send_log`)).rejects.toThrow(/permanente/);
    await expect(f(sql`update email_send_log set status = 'enviando'`)).rejects.toThrow(/só sai de/);
    await expect(f(sql`update email_live_authorizations set daily_limit = 200`)).rejects.toThrow(/só pode ser revogada/);
    await expect(f(sql`delete from email_live_authorizations`)).rejects.toThrow(/permanentes/);
    await revokeEmailLive(db, dirA, A);
    expect(await emailLiveActive(db, A, ON)).toBe(false);
    await expect(revokeEmailLive(db, dirA, A)).rejects.toThrow(/Não há autorização ativa/);
    const [rev] = await db.select().from(schema.emailLiveAuthorizations);
    expect(rev).toMatchObject({ active: false, revokedBy: dirA });
  });

  it("autorização: só diretoria; valida lista, domínio, limite, referência; substituir revoga a anterior", async () => {
    await expect(authorizeEmailLive(db, dirA, A, { reference: "doc 25/10", allowed: "@k3gsolutions.com.br", dailyLimit: 5 })).rejects.toThrow(/Cadastre antes a conta/);
    await saveEmailAccount(db, dirA, A, mail());
    for (const u of [gerA, asstA]) await expect(authorizeEmailLive(db, u, A, { reference: "doc 25/10", allowed: "@k3gsolutions.com.br", dailyLimit: 5 })).rejects.toBeInstanceOf(Forbidden);
    await expect(authorizeEmailLive(db, dirB, A, { reference: "doc 25/10", allowed: "@k3gsolutions.com.br", dailyLimit: 5 })).rejects.toBeInstanceOf(Forbidden);
    const bad = (o: Record<string, unknown>, re: RegExp) => expect(authorizeEmailLive(db, dirA, A, { reference: "doc 25/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: 5, ...o } as never)).rejects.toThrow(re);
    await bad({ reference: "x" }, /referência/); await bad({ dailyLimit: 0 }, /Limite diário/); await bad({ dailyLimit: 201 }, /Limite diário/); await bad({ allowed: "" }, /ao menos um/);
    await bad({ allowed: "@gmail.com" }, /só é aceito para o domínio do remetente/); await bad({ allowed: "sem-arroba" }, /inválido/); await bad({ allowed: Array.from({ length: 21 }, (_, i) => `a${i}@x.com`).join(",") }, /No máximo 20/);
    const a1 = await authorizeEmailLive(db, dirA, A, { reference: "doc 25/10/2026", allowed: "A@Externo.com;@k3gsolutions.com.br", dailyLimit: 5 });
    const a2 = await authorizeEmailLive(db, dirA, A, { reference: "doc 26/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: 7 });
    expect(a2.id).not.toBe(a1.id);
    const rows = await db.select().from(schema.emailLiveAuthorizations);
    expect(rows.filter((r) => r.active)).toHaveLength(1); expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a1.id)!.allowed).toEqual(["a@externo.com", "@k3gsolutions.com.br"]);
    expect(await getEmailLiveStatus(db, dirA, A)).toMatchObject({ authorization: { id: a2.id, dailyLimit: 7 }, sentToday: 0 });
  });

  it("e-mail de teste: três travas, lista, limite, registro sem endereço, só diretoria", async () => {
    await saveEmailAccount(db, dirA, A, mail());
    await expect(sendTestEmail(db, dirA, A, "x@k3gsolutions.com.br", {}, deps().smtp)).rejects.toThrow(/desligado no servidor/);
    await expect(sendTestEmail(db, dirA, A, "x@k3gsolutions.com.br", ON, deps().smtp)).rejects.toThrow(/Não há autorização/);
    await authorizeEmailLive(db, dirA, A, { reference: "doc 25/10/2026", allowed: "@k3gsolutions.com.br", dailyLimit: 3 });
    await expect(sendTestEmail(db, gerA, A, "x@k3gsolutions.com.br", ON, deps().smtp)).rejects.toBeInstanceOf(Forbidden);
    await expect(sendTestEmail(db, dirA, A, "x@fora.com", ON, deps().smtp)).rejects.toThrow(/não está na lista/);
    await expect(sendTestEmail(db, dirA, A, "invalido", ON, deps().smtp)).rejects.toThrow(/inválido/);
    expect(sent).toHaveLength(0);
    await sendTestEmail(db, dirA, A, "Teste@K3GSolutions.com.br", ON, deps().smtp);
    expect(sent).toHaveLength(1); expect(sent[0].m).toMatchObject({ to: ["teste@k3gsolutions.com.br"], subject: "Teste de e-mail do K3G Finance" });
    expect(String(sent[0].m.text)).not.toMatch(/Cliente|R\$/);
    behavior = async () => { throw Object.assign(new Error("x"), { responseCode: 535, command: "AUTH" }); };
    await expect(sendTestEmail(db, dirA, A, "x@k3gsolutions.com.br", ON, deps().smtp)).rejects.toThrow(/recusou o envio \(autenticacao_recusada\)/);
    behavior = async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); };
    await expect(sendTestEmail(db, dirA, A, "x@k3gsolutions.com.br", ON, deps().smtp)).rejects.toThrow(/não confirmou o envio/);
    expect((await listSendLog(db, dirA, A)).map((l) => l.status).sort()).toEqual(["desconhecido", "enviado", "falhou"]);
    const aud = await db.select().from(schema.auditLog);
    expect(JSON.stringify(aud)).not.toMatch(/teste@k3g|x@k3gsolutions|Senha-Do-Smtp/i);
  });

  it("revogou entre reservar e enviar: NADA é enviado, o item volta à fila e o registro marca a revogação (Codex E23 P1)", async () => {
    await setup();
    const r = await processQueue(db, asstA, A, D, undefined, { ...deps(), afterReserve: async () => { await revokeEmailLive(db, dirA, A); } });
    expect(sent).toHaveLength(0); expect(r.waiting).toMatch(/revogada/);
    expect(await st("Cliente Um")).toMatchObject({ status: "pendente", attempts: 0, lastError: "autorizacao_revogada" });
    expect(await listSendLog(db, dirA, A)).toMatchObject([{ status: "falhou", error: "autorizacao_revogada" }]);
  });

  it("o AGENDADOR nunca envia e-mail real: com o real liberado, os e-mails ficam na fila (Codex E23 P1)", async () => {
    await setup();
    await db.insert(schema.messagingSettings).values({ companyId: A, autoDispatch: true });
    const noon = new Date("2026-10-01T16:00:00Z"); // quinta-feira, 12h em Manaus: janela aberta
    const r = await runScheduled(db, A, noon, undefined, deps());
    expect(sent).toHaveLength(0); expect(r.waiting).toMatch(/só pelo botão Processar fila/);
    expect((await emails()).map((i) => i.status)).toEqual(["pendente", "pendente"]);
    expect(await listSendLog(db, dirA, A)).toHaveLength(0);
  });
});

