import { sql } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { localParts } from "@/modules/messaging/window";
import { importCoraInvoices, refreshCoraInvoices } from "./cora-invoices";

/**
 * Ciclo do agendador para o espelho dos boletos da Cora (só empresas que JÁ têm o espelho, isto é, que rodaram a importação). Só leitura na Cora.
 * Atualização rápida a cada 30 min (memória do processo); importação completa (acha boletos novos emitidos por fora) 1x por dia a partir das 06:00 de Manaus, controlada pelo registro no banco.
 */
const REFRESH_EVERY_MS = 30 * 60_000;
const state = { lastRefresh: 0 };
export const __resetCoraTick = () => { state.lastRefresh = 0; };

/** Reserva atômica da importação do dia: só UM processo ganha (advisory lock + marca na auditoria). A reserva vale 3 h: se o processo caiu no meio (sem o registro de conclusão), outra tentativa pode retomar depois disso. */
async function claimDailyImport(db: DB, companyId: string, day: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    await x.execute(sql`select pg_advisory_xact_lock(hashtext(${"cora-import:" + companyId}))`);
    const [done] = (await x.execute(sql`select 1 from audit_log where company_id = ${companyId} and ((action = 'cora.invoices.imported' and (created_at at time zone 'America/Manaus')::date = ${day}::date) or (action = 'cora.invoices.import_started' and created_at > ${new Date(now.getTime() - 3 * 3_600_000).toISOString()}::timestamptz)) limit 1`)) as unknown as unknown[];
    if (done) return false;
    await x.execute(sql`insert into audit_log (company_id, actor_id, action, detail, created_at) values (${companyId}, null, 'cora.invoices.import_started', '{}'::jsonb, ${now.toISOString()}::timestamptz)`);
    return true;
  });
}

export async function tickCoraInvoices(db: DB, now = new Date(), deps: Parameters<typeof importCoraInvoices>[3] = {}) {
  const out = { refreshed: 0, imported: 0, errors: 0 };
  const lp = localParts(now);
  const afterSix = lp.minutes >= 6 * 60, quick = now.getTime() - state.lastRefresh >= REFRESH_EVERY_MS;
  if (!quick) return out; // a importação completa sai no primeiro ciclo de 30 min depois das 06:00 (ver abaixo)
  const cs = (await db.execute(sql`select distinct company_id id from cora_invoices where environment = 'producao'`)) as unknown as { id: string }[];
  state.lastRefresh = now.getTime();
  for (const c of cs) {
    try {
      // a importação completa é RESERVADA no banco (uma por dia por empresa, mesmo com reinício ou mais de um agendador): trava + marca de início na mesma transação
      const full = afterSix && (await claimDailyImport(db, c.id, lp.date, now));
      if (full) { await importCoraInvoices(db, null, c.id, { ...deps, now }); out.imported++; }
      else { await refreshCoraInvoices(db, null, c.id, { ...deps, now }); out.refreshed++; }
    } catch { out.errors++; }
  }
  return out;
}
