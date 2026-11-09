import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createParty, getParty, importParties, setCustomerMode, setCustomerStatus, updateParty } from "@/modules/crm/service";
import { applySync, previewSync, saveConnection } from "@/modules/integrations/crm/sync";
import { MockCrmAdapter } from "@/modules/integrations/crm/mock";
import { cutoverView, performCutover, queueUnlinkedCustomers, retryFailedPushes } from "@/modules/integrations/crm/cutover";
import { enqueueCrmPush } from "@/modules/integrations/crm/outbox";
import { CrmPending, UNCERTAIN_CREATE_MS, backoffMs, processOutbox, MAX_ATTEMPTS, type CrmWriter, type RemoteCompany } from "@/modules/integrations/crm/writeback";
import { CrmError } from "@/modules/integrations/crm/types";

const enabled = !!process.env.POSTGRES_USER;
const ON = { CRM_SYNC_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35", CPF1 = "529.982.247-25";
const item = (o: Record<string, unknown> = {}) => ({ externalId: "c1", legalName: "Cliente Um", document: CNPJ1, active: true, contacts: [], ...o });

/** CRM de mentira: guarda o que recebe e falha sob comando. */
class FakeWriter implements CrmWriter {
  statuses: [string, string][] = []; created: { document: string; status: string; email: string | null }[] = []; remote = new Map<string, RemoteCompany>();
  fail: Error | null = null; seq = 0;
  async findByDocument(document: string) { if (this.fail) throw this.fail; return this.remote.get(document.replace(/\W/g, "").toUpperCase()) ?? null; }
  async setStatus(id: string, s: string) { if (this.fail) throw this.fail; this.statuses.push([id, s]); }
  async createCompany(i: { document: string; status: string; email: string | null }) { if (this.fail) throw this.fail; this.created.push({ document: i.document, status: i.status, email: i.email }); return { externalId: `crm-${++this.seq}` }; }
}

describe.skipIf(!enabled)("Corte do CRM: corte, fila de saída e envio (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string;

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    if (!(await admin`select 1 from pg_database where datname = 'k3gfinance_test'`).length) await admin.unsafe("create database k3gfinance_test");
    conn = postgres(base.replace(/\/k3gfinance$/, "/k3gfinance_test"), { max: 4 });
    db = drizzle(conn, { schema });
    await migrate(db, { migrationsFolder: "./drizzle" });
  });
  afterAll(async () => { await conn?.end(); await admin?.end(); });

  beforeEach(async () => {
    await db.execute(sql`truncate crm_outbox, integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com");
    await db.insert(schema.memberships).values([{ userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" }, { userId: gerA, companyId: A, role: "gerente" }]);
    await setCustomerMode(db, dirA, A, "crm"); await setCustomerMode(db, dirB, B, "crm");
    await saveConnection(db, dirA, A, { enabled: true }); await saveConnection(db, dirB, B, { enabled: true });
  });

  const freshSync = (c = A, ageMs = 60_000) => db.insert(schema.integrationSyncRuns).values({ companyId: c, kind: "crm", status: "applied", createdAt: new Date(Date.now() - ageMs) });
  const importOne = async (o: Record<string, unknown> = {}) => {
    const m = new MockCrmAdapter([item(o)]);
    const pv = await previewSync(db, m, dirA, A, ON); await applySync(db, m, dirA, A, pv.planHash, ON);
    return (await db.select().from(schema.customers).where(eq(schema.customers.companyId, A)))[0];
  };
  const doCut = (o: { phrase?: string; acceptStale?: boolean } = {}, who = dirA, c = A) => performCutover(db, who, c, { phrase: o.phrase ?? "CORTE", acceptStale: o.acceptStale ?? false });
  const rows = (c = A) => db.select().from(schema.crmOutbox).where(eq(schema.crmOutbox.companyId, c));

  it("o corte: só diretoria, frase, sem conflito aberto, sincronização recente; vira Finance a fonte e fecha a leitura", async () => {
    await importOne();
    await expect(doCut({}, gerA)).rejects.toThrow(Forbidden);
    await expect(doCut({ phrase: "corte?" })).rejects.toThrow(/Digite CORTE/);
    await db.insert(schema.integrationConflicts).values({ companyId: A, entity: "customer", externalId: "x9", reason: "duplicate_document", payload: {} });
    await expect(doCut()).rejects.toThrow(/conflito/);
    await db.update(schema.integrationConflicts).set({ status: "ignored" });
    await db.execute(sql`update integration_sync_runs set created_at = now() - interval '3 days'`);
    await expect(doCut()).rejects.toThrow(/mais de 24 horas/);
    expect((await cutoverView(db, dirA, A)).done).toBe(false);
    await doCut({ acceptStale: true });
    const v = await cutoverView(db, dirA, A);
    expect(v).toMatchObject({ done: true, mode: "local", linked: 1, unlinked: 0 });
    expect((await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.companyId, A)))[0].enabled).toBe(false);
    expect((await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.companyId, B)))[0].enabled).toBe(true); // outra empresa intacta
    await expect(doCut()).rejects.toThrow(/já foi feito/);
    await expect(setCustomerMode(db, dirA, A, "crm")).rejects.toThrow(/corte do CRM já foi feito/);
    const m = new MockCrmAdapter([item()]);
    await expect(previewSync(db, m, dirA, A, ON)).rejects.toThrow(/corte do CRM já foi feito|modo local/); // não lê mais
    expect(m.calls).toBe(0);
    const a = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "crm.cutover"));
    expect(a).toHaveLength(1);
    // a outra empresa não foi tocada
    expect((await cutoverView(db, dirB, B)).done).toBe(false);
  });

  it("corte exige empresa em modo CRM e sincronização recente passa sem a confirmação", async () => {
    await setCustomerMode(db, dirB, B, "local");
    await expect(doCut({}, dirB, B)).rejects.toThrow(/não lê clientes do CRM/);
    await freshSync(A);
    await doCut();
    expect((await cutoverView(db, dirA, A)).done).toBe(true);
  });

  it("antes do corte nada vai para a fila; depois, situação e cliente novo entram (e juntam pedidos repetidos)", async () => {
    await setCustomerMode(db, dirB, B, "local");
    const pre = await createParty(db, dirB, B, { kind: "cliente", legalName: "Antes Ltda", document: CNPJ1 });
    await setCustomerStatus(db, dirB, B, pre.id, "suspenso");
    expect(await rows(B)).toHaveLength(0);

    const c = await importOne(); await freshSync(); await doCut();
    await setCustomerStatus(db, dirA, A, c.id, "suspenso");
    await setCustomerStatus(db, dirA, A, c.id, "cancelado");
    let r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "status", state: "pendente", desiredStatus: "cancelado" }); // um pedido por cliente: vale o mais recente
    await updateParty(db, dirA, A, c.id, { kind: "cliente", legalName: "Cliente Um", document: CNPJ1, status: "suspenso" });
    r = await rows(); expect(r).toHaveLength(1); expect(r[0].desiredStatus).toBe("suspenso");

    const n = await createParty(db, dirA, A, { kind: "cliente", legalName: "Novo Ltda", document: CPF1 });
    r = await rows(); expect(r.find((x) => x.customerId === n.id)).toMatchObject({ kind: "create", state: "pendente", desiredStatus: "ativo" });
    // fornecedor não vai ao CRM
    await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Forn", document: CNPJ2 });
    expect(await rows()).toHaveLength(2);
    // situação não mudou → nada
    await setCustomerStatus(db, dirA, A, c.id, "suspenso");
    expect((await rows()).filter((x) => x.customerId === c.id)).toHaveLength(1);
  });

  it("importação CSV de clientes depois do corte enfileira a criação de cada um", async () => {
    await importOne(); await freshSync(); await doCut();
    const csv = ["tipo;razao_social;nome_fantasia;documento;email_financeiro;telefone;situacao", `cliente;Csv Um;;${CPF1};a@b.com;;ativo`, `fornecedor;Csv Forn;;${CNPJ2};;;ativo`].join("\n");
    const out = await importParties(db, dirA, A, csv);
    expect(out.imported).toBe(2);
    expect((await rows()).filter((x) => x.kind === "create")).toHaveLength(1);
  });

  it("envio: situação do cliente vinculado vai ao CRM com o valor ATUAL; auditado; fila fica 'enviado'", async () => {
    const c = await importOne(); await freshSync(); await doCut();
    await setCustomerStatus(db, dirA, A, c.id, "suspenso");
    const w = new FakeWriter();
    const out = await processOutbox(db, new Date(), { writer: w });
    expect(out).toMatchObject({ sent: 1, failed: 0, retry: 0 });
    expect(w.statuses).toEqual([["c1", "suspenso"]]);
    expect((await rows())[0]).toMatchObject({ state: "enviado", lastError: null });
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "crm.writeback.sent")))).toHaveLength(1);
    expect(await processOutbox(db, new Date(), { writer: w })).toMatchObject({ sent: 0 }); // nada a repetir
  });

  it("envio: criação — achou no CRM vincula; não achou cria com e-mail do contato financeiro e situação", async () => {
    await importOne(); await freshSync(); await doCut();
    await db.execute(sql`update customers set document = '99888777000166' where source = 'crm'`); // libera o CNPJ usado abaixo
    const w = new FakeWriter();
    w.remote.set("11222333000181", { externalId: "crm-ja-existe", crmStatus: "ACTIVE" });
    const dup = await createParty(db, dirA, A, { kind: "cliente", legalName: "Ja Existe", document: CNPJ1 });
    const nu = await createParty(db, dirA, A, { kind: "cliente", legalName: "Realmente Novo", document: CPF1, status: "suspenso" });
    await db.insert(schema.customerContacts).values({ companyId: A, partyId: nu.id, name: "Fin", email: "fin@novo.com", phone: null, isFinancial: true });
    const out = await processOutbox(db, new Date(), { writer: w });
    expect(out.sent).toBe(2);
    expect(w.created).toEqual([{ document: "52998224725", status: "suspenso", email: "fin@novo.com" }]); // só o que não existia
    expect((await getParty(db, dirA, A, dup.id))!.externalId).toBe("crm-ja-existe");
    expect((await getParty(db, dirA, A, nu.id))!.externalId).toBe("crm-1");
  });

  it("envio: falha de rede tenta de novo com espera; erro definitivo e limite de tentativas viram 'falhou'; CrmPending só espera", async () => {
    const c = await importOne(); await freshSync(); await doCut();
    await setCustomerStatus(db, dirA, A, c.id, "suspenso");
    const w = new FakeWriter(); const now = new Date();
    w.fail = new CrmError("CRM respondeu 503", true);
    expect(await processOutbox(db, now, { writer: w })).toMatchObject({ retry: 1, failed: 0 });
    let r = (await rows())[0];
    expect(r).toMatchObject({ state: "pendente", attempts: 1, lastError: "CRM respondeu 503" });
    expect(r.nextAttemptAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(await processOutbox(db, now, { writer: w })).toMatchObject({ retry: 0, sent: 0 }); // ainda não venceu
    // espera da equipe do CRM: não gasta tentativa
    w.fail = new CrmPending("rota de criação pendente");
    const later = new Date(now.getTime() + 3_600_000);
    expect(await processOutbox(db, later, { writer: w })).toMatchObject({ waiting: 1 });
    r = (await rows())[0]; expect(r).toMatchObject({ state: "pendente", attempts: 1 });
    // erro definitivo (4xx)
    w.fail = new CrmError("CRM respondeu 422");
    expect(await processOutbox(db, new Date(later.getTime() + 2 * 3_600_000), { writer: w })).toMatchObject({ failed: 1 });
    expect((await rows())[0]).toMatchObject({ state: "falhou", lastError: "CRM respondeu 422" });
    // tentar de novo recoloca; depois de MAX tentativas retryable vira falha
    expect(await retryFailedPushes(db, dirA, A)).toEqual({ retried: 1 });
    await db.update(schema.crmOutbox).set({ attempts: MAX_ATTEMPTS - 1 });
    w.fail = new CrmError("tempo esgotado", true);
    expect(await processOutbox(db, new Date(), { writer: w })).toMatchObject({ failed: 1 });
    await expect(retryFailedPushes(db, gerA, A)).rejects.toThrow(Forbidden);
  });

  it("sem chave/token de escrita nada sai e a fila é preservada; chave ligada mas sem token também", async () => {
    const c = await importOne(); await freshSync(); await doCut();
    await setCustomerStatus(db, dirA, A, c.id, "suspenso");
    const off = await processOutbox(db, new Date(), { env: {} as NodeJS.ProcessEnv });
    expect(off.skipped).toMatch(/desligado/);
    const noTok = await processOutbox(db, new Date(), { env: { CRM_WRITEBACK_ENABLED: "true", CRM_BASE_URL: "https://x.example" } as unknown as NodeJS.ProcessEnv });
    expect(noTok.skipped).toMatch(/desligado/);
    expect((await rows())[0]).toMatchObject({ state: "pendente", attempts: 0 });
  });

  it("enviar ao CRM os clientes sem vínculo: só depois do corte, só diretoria, só os sem cadastro lá; isolado por empresa", async () => {
    await importOne();
    await expect(queueUnlinkedCustomers(db, dirA, A)).rejects.toThrow(/corte/);
    await freshSync(); await doCut();
    await db.insert(schema.customers).values({ companyId: A, legalName: "Sem Vínculo", docType: "cnpj", document: "45723174000110", source: "manual" });
    await expect(queueUnlinkedCustomers(db, gerA, A)).rejects.toThrow(Forbidden);
    expect(await queueUnlinkedCustomers(db, dirA, A)).toEqual({ queued: 1 });
    expect(await queueUnlinkedCustomers(db, dirA, A)).toEqual({ queued: 1 }); // repetir não duplica (um aberto por cliente)
    expect(await rows()).toHaveLength(1);
    expect(await rows(B)).toHaveLength(0);
    expect((await cutoverView(db, dirA, A)).outbox.pendente).toBe(1);
    expect((await cutoverView(db, dirB, B)).outbox.pendente).toBe(0);
    // enfileirar fora do corte é ignorado
    const other = (await db.insert(schema.customers).values({ companyId: B, legalName: "B Cliente", docType: "cnpj", document: "45723174000110" }).returning())[0];
    expect(await enqueueCrmPush(db, B, other.id, "create", "ativo")).toBe(false);
  });

  it("ficha: a situação sugerida pelos contratos (regra pura) e a trava do CRM some depois do corte", async () => {
    const { suggestCustomerStatus } = await import("@/modules/contracts/customer-status");
    expect(suggestCustomerStatus([])).toBeNull();
    expect(suggestCustomerStatus(["rascunho"])).toBeNull();
    expect(suggestCustomerStatus(["ativo", "encerrado"])).toBe("ativo");
    expect(suggestCustomerStatus(["suspenso", "encerrado"])).toBe("suspenso");
    expect(suggestCustomerStatus(["encerrado", "encerrado"])).toBe("cancelado");
    expect(suggestCustomerStatus(["suspenso", "ativo"])).toBe("ativo");
    const c = await importOne();
    await setCustomerStatus(db, dirA, A, c.id, "suspenso");
    expect((await getParty(db, dirA, A, c.id))!.statusLocked).toBe(true); // antes do corte trava contra a sincronização
    await freshSync(); await doCut();
    expect((await getParty(db, dirA, A, c.id))!.statusLocked).toBe(false); // depois, a situação é só daqui
    await setCustomerStatus(db, dirA, A, c.id, "ativo");
    expect((await getParty(db, dirA, A, c.id))!).toMatchObject({ status: "ativo", statusLocked: false });
    const [row] = await db.select().from(schema.crmOutbox).where(and(eq(schema.crmOutbox.companyId, A), eq(schema.crmOutbox.customerId, c.id)));
    expect(row.desiredStatus).toBe("ativo");
  });

  it("criação com resultado incerto (erro depois do POST) espera mais antes de verificar de novo; «Tentar de novo» no meio anula a tentativa antiga", async () => {
    await importOne(); await freshSync(); await doCut();
    const n = await createParty(db, dirA, A, { kind: "cliente", legalName: "Incerto Ltda", document: CPF1 });
    const w = new FakeWriter(); const now = new Date();
    w.createCompany = async () => { throw new CrmError("tempo esgotado ao consultar o CRM", true); };
    expect(await processOutbox(db, now, { writer: w })).toMatchObject({ retry: 1 });
    const r = (await rows()).find((x) => x.customerId === n.id)!;
    expect(r.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + UNCERTAIN_CREATE_MS);

    // tentativa antiga que termina depois de um «Tentar de novo» não sobrescreve a linha
    await db.update(schema.crmOutbox).set({ state: "falhou" }).where(eq(schema.crmOutbox.id, r.id));
    const slow = new FakeWriter();
    slow.createCompany = async (i) => { await retryFailedPushes(db, dirA, A); return { externalId: `crm-${i.document}` }; }; // o retry acontece no meio do envio
    await db.update(schema.crmOutbox).set({ state: "pendente", nextAttemptAt: new Date(), attempts: 0 }).where(eq(schema.crmOutbox.id, r.id));
    await processOutbox(db, new Date(Date.now() + 1000), { writer: slow });
    const after = (await rows()).find((x) => x.customerId === n.id)!;
    expect(["pendente", "enviado"]).toContain(after.state); // nunca fica preso nem inconsistente
  });
});

