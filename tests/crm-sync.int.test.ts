import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { addContact, createParty, getParty, isBillable, listParties, removeContact, setArchived, setCustomerMode, updateParty } from "@/modules/crm/service";
import { applySync, listConflicts, listRuns, previewSync, resolveConflict, saveConnection } from "@/modules/integrations/crm/sync";
import type { CrmAdapter } from "@/modules/integrations/crm/types";
import { MockCrmAdapter } from "@/modules/integrations/crm/mock";

const enabled = !!process.env.POSTGRES_USER;
const ON = { CRM_SYNC_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35", CPF1 = "529.982.247-25";
const item = (o: Record<string, unknown> = {}) => ({ externalId: "c1", legalName: "Cliente Um", document: CNPJ1, active: true, contacts: [], ...o });

describe.skipIf(!enabled)("CRM sync: prévia, aplicação idempotente, conflitos, falhas e isolamento (DB de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, techA: string, contA: string;

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
    await db.execute(sql`truncate integration_conflicts, integration_sync_runs, integration_connections, rate_limits, customer_contacts, vendor_contacts, customers, vendors, audit_log, invitations, memberships, companies, users restart identity cascade`);
    const [a, b] = await db.insert(schema.companies).values([{ name: "A" }, { name: "B" }]).returning();
    A = a.id; B = b.id;
    const mk = async (e: string) => (await db.insert(schema.users).values({ email: e, name: e, passwordHash: "x" }).returning())[0].id;
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); techA = await mk("tech@t.com"); contA = await mk("cont@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" },
      { userId: gerA, companyId: A, role: "gerente" }, { userId: techA, companyId: A, role: "admin_tecnico" }, { userId: contA, companyId: A, role: "contabilidade" },
    ]);
    await setCustomerMode(db, dirA, A, "crm");
    await setCustomerMode(db, dirB, B, "crm");
    await saveConnection(db, dirA, A, { enabled: true });
    await saveConnection(db, dirB, B, { enabled: true });
  });

  // confirmação segura: revisa (prévia) e só então aplica exatamente o plano revisado
  const applyNow = async (_db: DB, m: CrmAdapter, u: string, c: string, env: NodeJS.ProcessEnv) => {
    const pv = await previewSync(db, m, u, c, env);
    return applySync(db, m, u, c, pv.planHash, env);
  };
  const total = async (c = A) => (await listParties(db, c === A ? dirA : dirB, c, {})).total;

  it("chave geral e conexão desligadas bloqueiam (padrão seguro)", async () => {
    const m = new MockCrmAdapter([item()]);
    await expect(previewSync(db, m, dirA, A, {} as unknown as NodeJS.ProcessEnv)).rejects.toThrow(/desativada/);
    await saveConnection(db, dirA, A, { enabled: false });
    await expect(previewSync(db, m, dirA, A, ON)).rejects.toThrow(/não está ativada/);
    expect(m.calls).toBe(0); // nem chegou a chamar o CRM
  });

  it("permissões: só quem grava clientes E gere integrações sincroniza (diretoria)", async () => {
    const m = new MockCrmAdapter([item()]);
    for (const u of [gerA, techA, contA]) await expect(previewSync(db, m, u, A, ON)).rejects.toBeInstanceOf(Forbidden);
    await expect(applyNow(db, m, gerA, A, ON)).rejects.toBeInstanceOf(Forbidden);
    await expect(saveConnection(db, gerA, A, { enabled: true })).rejects.toBeInstanceOf(Forbidden);
    expect(m.calls).toBe(0);
    await expect(previewSync(db, m, dirA, A, ON)).resolves.toBeTruthy();
  });

  it("prévia não grava; aplicar cria com contatos do CRM; reaplicar é idempotente", async () => {
    const m = new MockCrmAdapter([
      item({ contacts: [{ name: "Fin", email: "fin@c.com", isFinancial: true }] }),
      item({ externalId: "c2", legalName: "Cliente Dois", document: CNPJ2 }),
      item({ externalId: "c3", legalName: "Pessoa Três", document: CPF1 }),
    ]);
    const pv = await previewSync(db, m, dirA, A, ON);
    expect(pv.stats).toMatchObject({ fetched: 3, create: 3, conflict: 0 });
    expect(await total()).toBe(0);
    expect(await listRuns(db, dirA, A)).toHaveLength(0);

    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 3 });
    expect(await total()).toBe(3);
    const c1 = (await listParties(db, dirA, A, { q: "Cliente Um" })).items[0];
    const full = await getParty(db, dirA, A, c1.id);
    expect(full).toMatchObject({ source: "crm", externalId: "c1" });
    expect(full!.contacts[0]).toMatchObject({ email: "fin@c.com", isFinancial: true, source: "crm" });

    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 0, update: 0, archive: 0, unchanged: 3 }); // idempotente
    expect(await total()).toBe(3);
    expect(await listRuns(db, dirA, A)).toHaveLength(2);
  });

  it("alteração no CRM atualiza; contato digitado à mão sobrevive; contatos do CRM são trocados", async () => {
    const m = new MockCrmAdapter([item({ contacts: [{ name: "Antigo", isFinancial: true }] })]);
    await applyNow(db, m, dirA, A, ON);
    const id = (await listParties(db, dirA, A, {})).items[0].id;
    await addContact(db, dirA, A, id, { name: "Local" });
    m.items = [item({ legalName: "Cliente Um Renomeado", contacts: [{ name: "Novo", isFinancial: true }] })];
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ update: 1 });
    const p = (await getParty(db, dirA, A, id))!;
    expect(p.legalName).toBe("Cliente Um Renomeado");
    expect(p.contacts.map((c) => c.name).sort()).toEqual(["Local", "Novo"]);
  });

  it("inativo no CRM arquiva (não apaga); voltar a ativo restaura", async () => {
    const m = new MockCrmAdapter([item()]);
    await applyNow(db, m, dirA, A, ON);
    m.items = [item({ active: false })];
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ archive: 1 });
    expect(await total()).toBe(0);
    expect((await listParties(db, dirA, A, { archived: true })).total).toBe(1);
    m.items = [item({ active: true })];
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ restore: 1 });
    expect(await total()).toBe(1);
    m.items = [item({ externalId: "novo-inativo", document: CNPJ2, active: false })]; // inativo e nunca importado: ignora
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 0, skipped: 1 });
  });

  it("conflito com cadastro manual NUNCA sobrescreve; não duplica aviso; vincular e ignorar", async () => {
    await setCustomerMode(db, dirA, A, "local");
    const manual = await createParty(db, dirA, A, { kind: "cliente", legalName: "Manual Ltda", document: CNPJ1 });
    await setCustomerMode(db, dirA, A, "crm");
    const m = new MockCrmAdapter([item({ legalName: "Nome do CRM" })]);
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 0, conflict: 1 });
    expect((await getParty(db, dirA, A, manual.id))!.legalName).toBe("Manual Ltda"); // intacto
    expect(await total()).toBe(1);
    await applyNow(db, m, dirA, A, ON);
    const open = await listConflicts(db, dirA, A);
    expect(open).toHaveLength(1); // não duplicou
    expect(open[0]).toMatchObject({ reason: "duplicate_document", localId: manual.id });

    await resolveConflict(db, dirA, A, open[0].id, "link");
    expect((await getParty(db, dirA, A, manual.id))).toMatchObject({ source: "crm", externalId: "c1" });
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ update: 1, conflict: 0 }); // agora o CRM manda no cadastro
    expect((await getParty(db, dirA, A, manual.id))!.legalName).toBe("Nome do CRM");
    await expect(resolveConflict(db, dirA, A, open[0].id, "link")).rejects.toBeInstanceOf(Invalid); // já resolvido

    // ignorar: não volta a avisar
    const m2 = new MockCrmAdapter([item({ externalId: "x9", legalName: "Outro", document: CNPJ2 })]);
    await setCustomerMode(db, dirA, A, "local");
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Local Dois", document: CNPJ2 });
    await setCustomerMode(db, dirA, A, "crm");
    await applyNow(db, m2, dirA, A, ON);
    const [c2] = await listConflicts(db, dirA, A);
    await resolveConflict(db, dirA, A, c2.id, "ignore");
    expect(await applyNow(db, m2, dirA, A, ON)).toMatchObject({ conflict: 0, skipped: 1 });
    expect(await listConflicts(db, dirA, A)).toHaveLength(0);
  });

  it("colisão de documento: troca de documento no CRM para um já usado vira conflito", async () => {
    const m = new MockCrmAdapter([item(), item({ externalId: "c2", legalName: "Dois", document: CNPJ2 })]);
    await applyNow(db, m, dirA, A, ON);
    m.items = [item({ document: CNPJ2 }), item({ externalId: "c2", legalName: "Dois", document: CNPJ2 })];
    const s = await applyNow(db, m, dirA, A, ON);
    expect(s.conflict).toBeGreaterThanOrEqual(1);
    expect(await total()).toBe(2);
  });

  it("payload inválido, documento inválido e externalId repetido são contados e o resto segue", async () => {
    const m = new MockCrmAdapter([
      item(), { lixo: true }, item({ externalId: "c2", document: "123" }), item({ externalId: "c3", legalName: "x" }),
      item({ legalName: "Repetido" }), item({ externalId: "c4", legalName: "Quatro", document: CPF1 }),
    ]);
    const s = await applyNow(db, m, dirA, A, ON);
    expect(s).toMatchObject({ fetched: 6, create: 2, invalid: 4 });
    expect(await total()).toBe(2);
  });

  it("mapeamento de empresa: companyRef filtra outras empresas e sinaliza ambíguos", async () => {
    await saveConnection(db, dirA, A, { enabled: true, companyRef: "CNPJ-A" });
    const m = new MockCrmAdapter([
      item({ companyRef: "CNPJ-A" }), item({ externalId: "c2", legalName: "De B", document: CNPJ2, companyRef: "CNPJ-B" }),
      item({ externalId: "c3", legalName: "Sem ref", document: CPF1 }),
    ]);
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 1, skipped: 1, conflict: 1 });
    expect((await listConflicts(db, dirA, A))[0].reason).toBe("ambiguous_company");
  });

  it("falha do CRM: nada é gravado, a execução fica registrada como falha; paginação e laço de cursor", async () => {
    const m = new MockCrmAdapter([item(), item({ externalId: "c2", document: CNPJ2 })], { failOnCall: 1, failWith: "tempo esgotado" });
    await expect(applySync(db, m, dirA, A, "x", ON)).rejects.toThrow(/tempo esgotado/);
    expect(await total()).toBe(0);
    expect((await listRuns(db, dirA, A))[0]).toMatchObject({ status: "failed" });

    // a PRÉVIA também converte a falha em erro tratável (antes vazava como exceção não tratada na tela)
    await expect(previewSync(db, new MockCrmAdapter([item()], { failOnCall: 1, failWith: "CRM fora do ar" }), dirA, A, ON)).rejects.toThrow(/Não foi possível consultar o CRM: CRM fora do ar/);

    const paged = new MockCrmAdapter([item(), item({ externalId: "c2", legalName: "Dois", document: CNPJ2 }), item({ externalId: "c3", legalName: "Tres", document: CPF1 })], { pageSize: 1 });
    expect(await applyNow(db, paged, dirA, A, ON)).toMatchObject({ create: 3 });
    expect(paged.calls).toBe(6); // 3 páginas na prévia + 3 na aplicação
    const loop = new MockCrmAdapter([item(), item({ externalId: "c2" })], { pageSize: 1, loopCursor: true });
    await expect(applyNow(db, loop, dirA, A, ON)).rejects.toThrow(/laço|repetido/i);
  });

  it("isolamento: sincronizar B não toca A; conflito de A não pode ser resolvido por B", async () => {
    const m = new MockCrmAdapter([item()]);
    await applyNow(db, m, dirA, A, ON);
    await applyNow(db, m, dirB, B, ON); // mesmo externalId/documento em outra empresa: independente
    expect(await total(A)).toBe(1); expect(await total(B)).toBe(1);
    await setCustomerMode(db, dirA, A, "local");
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Manual", document: CNPJ2 });
    await setCustomerMode(db, dirA, A, "crm");
    await applyNow(db, new MockCrmAdapter([item({ externalId: "z", document: CNPJ2, legalName: "Zeta Ltda" })]), dirA, A, ON);
    const [conf] = await listConflicts(db, dirA, A);
    await expect(resolveConflict(db, dirB, B, conf.id, "ignore")).rejects.toBeInstanceOf(Invalid);
    expect(await listConflicts(db, dirB, B)).toHaveLength(0);
  });

  it("cadastro vindo do CRM é somente leitura no servidor (editar/arquivar bloqueados); contato local permitido", async () => {
    await applyNow(db, new MockCrmAdapter([item()]), dirA, A, ON);
    const id = (await listParties(db, dirA, A, {})).items[0].id;
    await expect(updateParty(db, dirA, A, id, { legalName: "Hack", document: CNPJ1 })).rejects.toThrow(/CRM/);
    await expect(setArchived(db, dirA, A, id, true)).rejects.toThrow(/CRM/);
    await addContact(db, dirA, A, id, { name: "Contato local" }); // permitido
    expect((await getParty(db, dirA, A, id))!.legalName).toBe("Cliente Um");
  });

  it("P1: confirmar só aplica o plano REVISADO (hash); se o CRM mudou, exige nova revisão", async () => {
    const m = new MockCrmAdapter([item()]);
    const pv = await previewSync(db, m, dirA, A, ON);
    m.items = [item(), item({ externalId: "c2", legalName: "Entrou Depois", document: CNPJ2 })]; // o CRM mudou após a prévia
    await expect(applySync(db, m, dirA, A, pv.planHash, ON)).rejects.toThrow(/mudaram desde a revisão/);
    await expect(applySync(db, m, dirA, A, "", ON)).rejects.toThrow(/mudaram desde a revisão/); // sem hash: recusado
    expect(await total()).toBe(0); // nada foi gravado
    const pv2 = await previewSync(db, m, dirA, A, ON);
    expect(pv2.planHash).not.toBe(pv.planHash);
    expect(await applySync(db, m, dirA, A, pv2.planHash, ON)).toMatchObject({ create: 2 });
  });

  it("P2: mudança só nos contatos do CRM entra na sincronização; contato local é preservado", async () => {
    const m = new MockCrmAdapter([item({ contacts: [{ name: "Ana", email: "ana@x.com", isFinancial: true }] })]);
    await applyNow(db, m, dirA, A, ON);
    const id = (await listParties(db, dirA, A, {})).items[0].id;
    await addContact(db, dirA, A, id, { name: "Local" });
    m.items = [item({ contacts: [{ name: "Ana", email: "ana@novo.com", isFinancial: true }] })]; // só o e-mail mudou
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ update: 1 });
    const p = (await getParty(db, dirA, A, id))!;
    expect(p.contacts.find((c) => c.name === "Ana")!.email).toBe("ana@novo.com");
    expect(p.contacts.some((c) => c.name === "Local")).toBe(true);
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ update: 0, unchanged: 1 }); // estável
  });

  it("P1: contato vindo do CRM não pode ser removido (servidor); contato local pode", async () => {
    await applyNow(db, new MockCrmAdapter([item({ contacts: [{ name: "Do CRM", isFinancial: true }] })]), dirA, A, ON);
    const id = (await listParties(db, dirA, A, {})).items[0].id;
    await addContact(db, dirA, A, id, { name: "Local" });
    const { contacts } = (await getParty(db, dirA, A, id))!;
    await expect(removeContact(db, dirA, A, contacts.find((c) => c.source === "crm")!.id)).rejects.toThrow(/CRM/);
    await removeContact(db, dirA, A, contacts.find((c) => c.source === "manual")!.id);
    expect((await getParty(db, dirA, A, id))!.contacts).toHaveLength(1);
  });

  it("P2: ao resolver um conflito o payload (nome/documento) é apagado", async () => {
    await setCustomerMode(db, dirA, A, "local");
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Local", document: CNPJ1 });
    await setCustomerMode(db, dirA, A, "crm");
    await applyNow(db, new MockCrmAdapter([item({ legalName: "Nome Sensível" })]), dirA, A, ON);
    const [c] = await listConflicts(db, dirA, A);
    expect(JSON.stringify(c.payload)).toContain("Nome Sensível");
    await resolveConflict(db, dirA, A, c.id, "ignore");
    const [after] = await db.select().from(schema.integrationConflicts);
    expect(after.payload).toEqual({});
  });

  it("situação: suspenso e cancelado são IMPORTADOS como clientes (não arquivados); só o ativo é faturável", async () => {
    const m = new MockCrmAdapter([
      item(), item({ externalId: "c2", legalName: "Cliente Suspenso", document: CNPJ2, status: "suspenso" }),
      item({ externalId: "c3", legalName: "Cliente Cancelado", document: CPF1, status: "cancelado" }),
    ]);
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 3, archive: 0 });
    const all = (await listParties(db, dirA, A, {})).items;
    expect(all).toHaveLength(3); // todos listados, nenhum arquivado
    const bySt = Object.fromEntries(all.map((c) => [c.legalName, c]));
    expect(bySt["Cliente Um"].status).toBe("ativo");
    expect(bySt["Cliente Suspenso"].status).toBe("suspenso");
    expect(bySt["Cliente Cancelado"].status).toBe("cancelado");
    expect(all.filter((c) => isBillable(c)).map((c) => c.legalName)).toEqual(["Cliente Um"]); // só o ativo fatura
    expect((await listParties(db, dirA, A, { status: "cancelado" })).items.map((c) => c.legalName)).toEqual(["Cliente Cancelado"]);
  });

  it("mudança de situação no CRM atualiza (sem arquivar); prospect (não é cliente) é ignorado e, se já existia, arquiva", async () => {
    const m = new MockCrmAdapter([item()]);
    await applyNow(db, m, dirA, A, ON);
    m.items = [item({ status: "suspenso" })];
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ update: 1, archive: 0 });
    expect((await listParties(db, dirA, A, {})).items[0].status).toBe("suspenso");
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ update: 0, unchanged: 1 }); // idempotente
    m.items = [item({ status: "ativo" })];
    await applyNow(db, m, dirA, A, ON);
    expect((await listParties(db, dirA, A, {})).items[0].status).toBe("ativo");
    m.items = [item({ externalId: "p1", legalName: "Só Prospect", document: CNPJ2, active: false })];
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ create: 0, skipped: 1 }); // prospect nunca entra
    m.items = [item({ active: false })]; // deixou de ser cliente no CRM
    expect(await applyNow(db, m, dirA, A, ON)).toMatchObject({ archive: 1 });
  });

  it("auditoria e execuções guardam só contagens (sem PII)", async () => {
    await applyNow(db, new MockCrmAdapter([item({ legalName: "Segredo Silva", contacts: [{ name: "Maria", email: "maria@x.com" }] })]), dirA, A, ON);
    const logs = JSON.stringify(await db.select().from(schema.auditLog).where(sql`action = 'crm.sync.applied'`));
    const runs = JSON.stringify(await db.select().from(schema.integrationSyncRuns));
    for (const s of [logs, runs]) { expect(s).not.toMatch(/Segredo|Maria|maria@x|11222333/); }
    expect(logs).toContain('"create":1');
  });
});
