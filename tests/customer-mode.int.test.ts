import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { databaseUrl } from "@/lib/db/url";
import * as schema from "@/lib/db/schema";
import type { DB } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { addContact, createParty, getCustomerMode, getParty, importParties, listParties, previewImport, removeContact, setArchived, setCustomerMode, updateParty } from "@/modules/crm/service";
import { applySync, listConflicts, previewSync, resolveConflict, saveConnection } from "@/modules/integrations/crm/sync";
import { MockCrmAdapter } from "@/modules/integrations/crm/mock";

const enabled = !!process.env.POSTGRES_USER;
const ON = { CRM_SYNC_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;
const CNPJ1 = "11.222.333/0001-81", CNPJ2 = "12.ABC.345/01DE-35", CPF1 = "529.982.247-25";
const item = (o: Record<string, unknown> = {}) => ({ externalId: "c1", legalName: "Cliente CRM", document: CNPJ1, active: true, contacts: [], ...o });

describe.skipIf(!enabled)("Dois cenários: clientes locais x importados do CRM (por empresa, imposto no servidor)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>, db: DB;
  let A: string, B: string, dirA: string, dirB: string, gerA: string, techA: string;

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
    dirA = await mk("dir-a@t.com"); dirB = await mk("dir-b@t.com"); gerA = await mk("ger@t.com"); techA = await mk("tech@t.com");
    await db.insert(schema.memberships).values([
      { userId: dirA, companyId: A, role: "diretoria" }, { userId: dirB, companyId: B, role: "diretoria" },
      { userId: gerA, companyId: A, role: "gerente" }, { userId: techA, companyId: A, role: "admin_tecnico" },
    ]);
  });

  it("padrão é LOCAL; só quem gere integrações E grava clientes troca o modo; trocar é auditado", async () => {
    expect(await getCustomerMode(db, dirA, A)).toBe("local");
    await expect(setCustomerMode(db, gerA, A, "crm")).rejects.toBeInstanceOf(Forbidden);   // gerente: sem integrations.manage
    await expect(setCustomerMode(db, techA, A, "crm")).rejects.toBeInstanceOf(Forbidden);  // admin técnico: sem crm.write
    await expect(setCustomerMode(db, dirA, A, "xyz" as never)).rejects.toBeInstanceOf(Invalid);
    await setCustomerMode(db, dirA, A, "crm");
    expect(await getCustomerMode(db, dirA, A)).toBe("crm");
    const log = await db.select().from(schema.auditLog).where(sql`action = 'company.customer_mode_changed'`);
    expect(log).toHaveLength(1);
    expect(log[0].detail).toEqual({ from: "local", to: "crm" });
    await setCustomerMode(db, dirA, A, "crm"); // repetir não gera auditoria nova
    expect(await db.select().from(schema.auditLog).where(sql`action = 'company.customer_mode_changed'`)).toHaveLength(1);
  });

  it("o modo é POR EMPRESA: mudar A não afeta B", async () => {
    await setCustomerMode(db, dirA, A, "crm");
    expect(await getCustomerMode(db, dirB, B)).toBe("local");
    await expect(setCustomerMode(db, dirA, B, "crm")).rejects.toBeInstanceOf(Forbidden); // dirA não é membro de B
    expect((await createParty(db, dirB, B, { kind: "cliente", legalName: "Cliente B", document: CNPJ1 })).legalName).toBe("Cliente B");
    await expect(createParty(db, dirA, A, { kind: "cliente", legalName: "Cliente A", document: CNPJ1 })).rejects.toThrow(/vêm do CRM/);
  });

  it("modo LOCAL: cadastro manual e CSV funcionam; sincronizar com o CRM é recusado", async () => {
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Local", document: CNPJ1 });
    const csv = `tipo;razao_social;documento\ncliente;Via CSV;${CNPJ2}\nfornecedor;Forn;${CPF1}`;
    expect((await previewImport(db, dirA, A, csv)).summary).toMatchObject({ ok: 2 });
    expect(await importParties(db, dirA, A, csv)).toMatchObject({ imported: 2 });
    await saveConnection(db, dirA, A, { enabled: true });
    const m = new MockCrmAdapter([item({ document: CNPJ2, externalId: "z" })]);
    await expect(previewSync(db, m, dirA, A, ON)).rejects.toThrow(/modo local/);
    await expect(applySync(db, m, dirA, A, "x", ON)).rejects.toThrow(/modo local/);
    expect(m.calls).toBe(0); // nem chamou o CRM
  });

  it("modo CRM: clientes NÃO podem ser criados nem importados por CSV; fornecedores continuam locais", async () => {
    await setCustomerMode(db, dirA, A, "crm");
    await expect(createParty(db, dirA, A, { kind: "cliente", legalName: "Manual", document: CNPJ1 })).rejects.toThrow(/vêm do CRM/);
    expect((await createParty(db, dirA, A, { kind: "fornecedor", legalName: "Fornecedor Local", document: CNPJ1 })).kind).toBe("fornecedor");
    const csv = `tipo;razao_social;documento\ncliente;Cliente CSV;${CNPJ2}\nfornecedor;Forn CSV;${CPF1}`;
    const pv = await previewImport(db, dirA, A, csv);
    expect(pv.summary).toEqual({ ok: 1, erro: 1, duplicado: 0 });
    expect(pv.rows[0].message).toMatch(/vêm do CRM/);
    expect(await importParties(db, dirA, A, csv)).toEqual({ imported: 1, skipped: 1 }); // revalidado no servidor
    expect((await listParties(db, dirA, A, { kind: "cliente" })).total).toBe(0);
  });

  it("alternar: cadastro do CRM é somente leitura no modo CRM e EDITÁVEL no modo local (e volta a bloquear)", async () => {
    await setCustomerMode(db, dirA, A, "crm");
    await saveConnection(db, dirA, A, { enabled: true });
    const m = new MockCrmAdapter([item({ contacts: [{ name: "Do CRM", isFinancial: true }] })]);
    const pv = await previewSync(db, m, dirA, A, ON);
    await applySync(db, m, dirA, A, pv.planHash, ON);
    const id = (await listParties(db, dirA, A, {})).items[0].id;
    const crmContact = (await getParty(db, dirA, A, id))!.contacts[0];
    const edit = { legalName: "Editado Localmente", document: CNPJ1 };

    await expect(updateParty(db, dirA, A, id, edit)).rejects.toThrow(/CRM/);
    await expect(setArchived(db, dirA, A, id, true)).rejects.toThrow(/CRM/);
    await expect(removeContact(db, dirA, A, crmContact.id)).rejects.toThrow(/CRM/);

    await setCustomerMode(db, dirA, A, "local"); // libera
    await updateParty(db, dirA, A, id, edit);
    expect((await getParty(db, dirA, A, id))!.legalName).toBe("Editado Localmente");
    await removeContact(db, dirA, A, crmContact.id);
    await expect(previewSync(db, m, dirA, A, ON)).rejects.toThrow(/modo local/);

    await setCustomerMode(db, dirA, A, "crm"); // volta: o CRM manda de novo
    await expect(updateParty(db, dirA, A, id, edit)).rejects.toThrow(/CRM/);
    const pv2 = await previewSync(db, m, dirA, A, ON);
    expect(pv2.stats).toMatchObject({ update: 1 }); // nome local diverge do CRM e contato removido é recriado
    await applySync(db, m, dirA, A, pv2.planHash, ON);
    const back = (await getParty(db, dirA, A, id))!;
    expect(back.legalName).toBe("Cliente CRM");
    expect(back.contacts.map((c) => c.name)).toEqual(["Do CRM"]);
    await addContact(db, dirA, A, id, { name: "Contato local" }); // contato local é permitido nos dois modos
  });

  it("P1: resolver conflito (vincular ao CRM) é recusado no servidor quando a empresa está em modo LOCAL", async () => {
    await createParty(db, dirA, A, { kind: "cliente", legalName: "Local", document: CNPJ1 });
    await setCustomerMode(db, dirA, A, "crm");
    await saveConnection(db, dirA, A, { enabled: true });
    const m = new MockCrmAdapter([item()]);
    const pv = await previewSync(db, m, dirA, A, ON);
    await applySync(db, m, dirA, A, pv.planHash, ON);
    const [conf] = await listConflicts(db, dirA, A);
    expect(conf).toBeTruthy();
    await setCustomerMode(db, dirA, A, "local");
    await expect(resolveConflict(db, dirA, A, conf.id, "link")).rejects.toThrow(/modo local/);
    await expect(resolveConflict(db, dirA, A, conf.id, "ignore")).rejects.toThrow(/modo local/);
    const [local] = await db.select().from(schema.customers);
    expect(local.source).toBe("manual"); // nada foi vinculado
  });

  it("P2: ler o modo exige ser membro da empresa; o banco só aceita 'local' ou 'crm'", async () => {
    await expect(getCustomerMode(db, dirA, B)).rejects.toBeInstanceOf(Forbidden);
    await expect(db.execute(sql`update companies set customer_mode = 'qualquer' where id = ${A}`)).rejects.toThrow();
  });

  it("P1: troca de modo e gravação são serializadas (sem corrida): nunca grava cliente DEPOIS da troca para CRM", async () => {
    for (let i = 0; i < 25; i++) {
      await db.execute(sql`truncate customers, audit_log restart identity cascade`);
      await db.update(schema.companies).set({ customerMode: "local" }).where(sql`id = ${A}`);
      const [created, switched] = await Promise.allSettled([
        createParty(db, dirA, A, { kind: "cliente", legalName: `Corrida ${i}`, document: CNPJ1 }),
        setCustomerMode(db, dirA, A, "crm"),
      ]);
      expect(switched.status).toBe("fulfilled");
      const rows = await db.execute(sql`select (select xmin::text::bigint from customers limit 1) as cx, (select xmin::text::bigint from companies where id = ${A}) as mx`);
      const { cx, mx } = (rows as unknown as { cx: string | null; mx: string }[])[0];
      if (created.status === "fulfilled") {
        // gravou: tem de ter gravado ANTES da troca (xid menor). Se a troca veio primeiro, a criação precisa ter sido recusada.
        expect(Number(cx)).toBeLessThan(Number(mx));
      } else {
        expect(String((created as PromiseRejectedResult).reason?.message)).toMatch(/vêm do CRM/);
        expect(cx).toBeNull();
      }
    }
  });

  it("P1: importação com prévia velha: se a empresa virou CRM no meio, nenhum cliente é gravado", async () => {
    const csv = `tipo;razao_social;documento\ncliente;Via CSV;${CNPJ2}`;
    expect((await previewImport(db, dirA, A, csv)).summary.ok).toBe(1); // prévia em modo local
    await setCustomerMode(db, dirA, A, "crm");
    await expect(importParties(db, dirA, A, csv)).resolves.toEqual({ imported: 0, skipped: 1 }); // revalidada: agora é erro
    expect((await listParties(db, dirA, A, { kind: "cliente" })).total).toBe(0);
  });
});
