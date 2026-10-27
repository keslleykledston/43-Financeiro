import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { databaseUrl } from "@/lib/db/url";

const enabled = !!process.env.POSTGRES_USER;
const PROBE = "k3g_guard_probe"; // nome que NÃO termina em _test: o gatilho vale como em produção

describe.skipIf(!enabled)("E32 — TRUNCATE bloqueado nas tabelas de registro imutável (fora do banco de teste)", () => {
  let admin: ReturnType<typeof postgres>, conn: ReturnType<typeof postgres>;
  const q = async (text: string) => { try { await conn.unsafe(text); return ""; } catch (e) { return (e as Error).message; } };

  beforeAll(async () => {
    const base = databaseUrl();
    admin = postgres(base.replace(/\/k3gfinance$/, "/postgres"), { max: 1 });
    await admin.unsafe(`drop database if exists ${PROBE}`);
    await admin.unsafe(`create database ${PROBE}`);
    conn = postgres(base.replace(/\/k3gfinance$/, `/${PROBE}`), { max: 1 });
    await migrate(drizzle(conn), { migrationsFolder: "./drizzle" });
  }, 120_000);
  afterAll(async () => { await conn?.end(); await admin?.unsafe(`drop database if exists ${PROBE}`); await admin?.end(); });

  it("TRUNCATE nas tabelas protegidas é recusado, mesmo com CASCADE", async () => {
    for (const t of ["notes", "payments", "payables", "expense_applications", "legacy_billing_rows", "boleto_cancel_requests", "bank_transactions", "partner_entries"]) {
      expect(await q(`truncate ${t}`)).toMatch(/TRUNCATE não é permitido|referenced in a foreign key/); // tabela referenciada por FK já nem chega ao gatilho; o resto, o gatilho barra
      expect(await q(`truncate ${t} cascade`)).toMatch(/TRUNCATE não é permitido/);
    }
  });

  it("manutenção deliberada: desligar o gatilho na transação libera; ao reativar, volta a bloquear", async () => {
    expect(await q(`begin; alter table notes disable trigger notes_no_truncate_trg; truncate notes; alter table notes enable trigger notes_no_truncate_trg; commit`)).toBe("");
    expect(await q(`truncate notes cascade`)).toMatch(/TRUNCATE não é permitido/);
  });
  it("o registro de atividades (audit_log) também não pode ser truncado", async () => {
    expect(await q(`truncate audit_log cascade`)).toMatch(/TRUNCATE não é permitido/);
  });

  it("tabelas comuns continuam truncáveis; banco com nome terminado em _test é isento", async () => {
    expect(await q(`truncate rate_limits`)).toBe("");
    await admin.unsafe(`drop database if exists k3g_exempt_test`); await admin.unsafe(`create database k3g_exempt_test`);
    const ex = postgres(databaseUrl().replace(/\/k3gfinance$/, "/k3g_exempt_test"), { max: 1 });
    try { await migrate(drizzle(ex), { migrationsFolder: "./drizzle" }); await ex.unsafe("truncate notes cascade"); }
    finally { await ex.end(); await admin.unsafe(`drop database if exists k3g_exempt_test`); }
  }, 120_000);
});
