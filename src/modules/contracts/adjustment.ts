import { and, eq } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { auditLog, contractAdjustmentRules, contractAlertSnoozes, contracts } from "@/lib/db/schema";
import { Invalid, requirePerm } from "@/modules/identity/service";
import { todayManaus } from "@/modules/messaging/service";
import type { AlertKind } from "./alerts";

/**
 * E31 — reajuste anual e silenciar alertas. Nada aqui muda valor de contrato nem cobra: a regra de reajuste só informa (índice/percentual) e ajuda a
 * PRÉ-PREENCHER o aditivo, que continua passando pelo fluxo normal de aprovação. Adiar/ignorar vale para UM ciclo (a data do alerta): no ciclo
 * seguinte o alerta volta sozinho, então nada fica esquecido para sempre.
 */
export const INDEX_CODES = ["ipca", "igpm", "inpc", "fixo", "outro"] as const;
export type IndexCode = (typeof INDEX_CODES)[number];
export const INDEX_LABEL: Record<IndexCode, string> = { ipca: "IPCA", igpm: "IGP-M", inpc: "INPC", fixo: "Percentual fixo", outro: "Outro (veja a observação)" };
export const ALERT_KINDS: AlertKind[] = ["vigencia_encerrada", "vigencia_proxima", "renovacao_proxima", "reajuste_atrasado", "reajuste_proximo"];
export const MAX_SNOOZE_DAYS = 120;

const audit = (x: DB, companyId: string, actorId: string, action: string, detail: Record<string, unknown>) => x.insert(auditLog).values({ companyId, actorId, action, detail });
const uuidOk = (s: string) => /^[0-9a-f-]{36}$/i.test(s ?? "");
const isoOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** "4,5" / "4.5%" → 450 pontos-base (0 a 100). */
export function parsePctBps(raw: unknown): number {
  const s = String(raw ?? "").trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw new Invalid("Percentual inválido: informe de 0 a 100 (ex.: 4,5)");
  const b = Math.round(Number(s) * 100);
  if (b < 0 || b > 10000) throw new Invalid("Percentual inválido: informe de 0 a 100 (ex.: 4,5)");
  return b;
}
export const MAX_CONTRACT_CENTS = 9_999_999_999_999; // R$ 99.999.999.999,99: o mesmo teto do valor mensal do contrato
/** Valor sugerido = atual × (1 + percentual), arredondado ao centavo (conta em BigInt: sem perda de precisão). Acima do teto do contrato: null (não sugere). */
export function suggestedCents(currentCents: number, bps: number): number | null {
  const v = (BigInt(Math.trunc(currentCents)) * BigInt(10000 + bps) + 5000n) / 10000n;
  return v > BigInt(MAX_CONTRACT_CENTS) ? null : Number(v);
}
export const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

export type Rule = { indexCode: IndexCode; fixedBps: number | null; note: string | null };
export async function saveAdjustmentRule(db: DB, actorId: string, companyId: string, contractId: string, i: { index: string; fixedPct?: string; note?: string }) {
  await requirePerm(db, actorId, companyId, "contracts.write");
  if (!uuidOk(contractId)) throw new Invalid("Contrato não encontrado");
  if (!(INDEX_CODES as readonly string[]).includes(i.index)) throw new Invalid("Índice inválido");
  const fixedBps = i.index === "fixo" ? parsePctBps(i.fixedPct) : null;
  const note = String(i.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length > 200) throw new Invalid("Observação muito longa (máximo 200)");
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [c] = await x.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, contractId), eq(contracts.companyId, companyId)));
    if (!c) throw new Invalid("Contrato não encontrado");
    await x.insert(contractAdjustmentRules).values({ companyId, contractId, indexCode: i.index, fixedBps, note: note || null, updatedBy: actorId })
      .onConflictDoUpdate({ target: contractAdjustmentRules.contractId, set: { indexCode: i.index, fixedBps, note: note || null, updatedBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "contract.adjustment_rule_saved", { contractId, index: i.index });
  });
}
export async function getAdjustmentRule(db: DB, actorId: string, companyId: string, contractId: string): Promise<Rule | null> {
  await requirePerm(db, actorId, companyId, "contracts.read");
  if (!uuidOk(contractId)) return null;
  const [r] = await db.select().from(contractAdjustmentRules).where(and(eq(contractAdjustmentRules.contractId, contractId), eq(contractAdjustmentRules.companyId, companyId)));
  return r ? { indexCode: r.indexCode as IndexCode, fixedBps: r.fixedBps, note: r.note } : null;
}

/** Adia (`days` 1 a 120) ou ignora neste ciclo (`days` omitido). A chave é (contrato, tipo, data do alerta). */
export async function snoozeAlert(db: DB, actorId: string, companyId: string, i: { contractId: string; kind: string; dueDate: string; days?: number; note?: string }, today = todayManaus()) {
  await requirePerm(db, actorId, companyId, "contracts.write");
  if (!uuidOk(i.contractId)) throw new Invalid("Contrato não encontrado");
  if (!(ALERT_KINDS as string[]).includes(i.kind)) throw new Invalid("Tipo de alerta inválido");
  if (!isoOk(i.dueDate)) throw new Invalid("Data do alerta inválida");
  let until: string | null = null;
  if (i.days !== undefined && i.days !== null) {
    if (!Number.isInteger(i.days) || i.days < 1 || i.days > MAX_SNOOZE_DAYS) throw new Invalid(`Adiar de 1 a ${MAX_SNOOZE_DAYS} dias`);
    until = addDays(today, i.days);
  }
  const note = String(i.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  await db.transaction(async (tx) => {
    const x = tx as unknown as DB;
    const [c] = await x.select({ id: contracts.id }).from(contracts).where(and(eq(contracts.id, i.contractId), eq(contracts.companyId, companyId)));
    if (!c) throw new Invalid("Contrato não encontrado");
    await x.insert(contractAlertSnoozes).values({ companyId, contractId: i.contractId, kind: i.kind, dueDate: i.dueDate, until, note: note || null, createdBy: actorId })
      .onConflictDoUpdate({ target: [contractAlertSnoozes.contractId, contractAlertSnoozes.kind, contractAlertSnoozes.dueDate], set: { until, note: note || null, createdBy: actorId, updatedAt: new Date() } });
    await audit(x, companyId, actorId, "contract.alert_snoozed", { contractId: i.contractId, kind: i.kind, forever: until === null });
  });
}
export async function unsnoozeAlert(db: DB, actorId: string, companyId: string, snoozeId: string) {
  await requirePerm(db, actorId, companyId, "contracts.write");
  if (!uuidOk(snoozeId)) throw new Invalid("Item não encontrado");
  const r = await db.delete(contractAlertSnoozes).where(and(eq(contractAlertSnoozes.id, snoozeId), eq(contractAlertSnoozes.companyId, companyId))).returning({ contractId: contractAlertSnoozes.contractId, kind: contractAlertSnoozes.kind });
  if (r.length !== 1) throw new Invalid("Item não encontrado");
  await audit(db, companyId, actorId, "contract.alert_unsnoozed", { contractId: r[0].contractId, kind: r[0].kind });
}
/** O silêncio vale enquanto não passou da data (ou para sempre naquele ciclo, se `until` é nulo). */
export const isSnoozed = (s: { until: string | null }, today: string) => s.until === null || s.until >= today;
