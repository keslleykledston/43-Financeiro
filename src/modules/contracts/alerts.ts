import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { contracts, contractVersions, customers } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { requirePerm } from "@/modules/identity/service";

/**
 * Alertas de contrato (E17): vigência (fim próximo ou já passado) e reajuste (12 meses desde o início ou desde a última
 * mudança de valor aprovada). Só leitura: nada é alterado nem enviado; quem decide é a pessoa, pelo fluxo de alteração de contrato.
 */
export type AlertKind = "vigencia_encerrada" | "vigencia_proxima" | "reajuste_atrasado" | "reajuste_proximo";
export const ALERT_LABEL: Record<AlertKind, string> = {
  vigencia_encerrada: "Vigência terminou", vigencia_proxima: "Vigência termina em breve", reajuste_atrasado: "Reajuste em atraso", reajuste_proximo: "Reajuste se aproxima",
};
export const WINDOWS = [30, 60, 90] as const;
export const DEFAULT_WINDOW = 60;

export type AlertInput = {
  id: string; customerName: string; status: string; startAt: string; endAt: string | null; amountCents: number;
  /** valores mensais das versões APROVADAS, da mais antiga à mais nova, com a data (YYYY-MM-DD) da aprovação */
  approved: { cents: number; on: string }[];
};
export type ContractAlert = { contractId: string; customerName: string; kind: AlertKind; date: string; days: number; amountCents: number; since?: string };

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / 86400000);

/** Mesma data um ano depois (29/02 → 28/02 em ano não bissexto). */
export function plusYear(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Data de referência do reajuste: última aprovação que MUDOU o valor mensal; sem mudança, o início da vigência. */
export function adjustmentReference(c: Pick<AlertInput, "startAt" | "approved">): string {
  let ref = c.startAt;
  for (let i = 1; i < c.approved.length; i++) if (c.approved[i].cents !== c.approved[i - 1].cents) ref = c.approved[i].on > ref ? c.approved[i].on : ref;
  return ref;
}

export function contractAlerts(items: AlertInput[], today: string, windowDays: number = DEFAULT_WINDOW): ContractAlert[] {
  const out: ContractAlert[] = [];
  for (const c of items) {
    if (c.status !== "ativo" && c.status !== "suspenso") continue; // rascunho e encerrado não geram alerta
    if (c.endAt) {
      const left = daysBetween(today, c.endAt);
      if (left < 0) out.push({ contractId: c.id, customerName: c.customerName, kind: "vigencia_encerrada", date: c.endAt, days: Math.abs(left), amountCents: c.amountCents });
      else if (left <= windowDays) out.push({ contractId: c.id, customerName: c.customerName, kind: "vigencia_proxima", date: c.endAt, days: left, amountCents: c.amountCents });
    }
    if (c.status !== "ativo") continue;
    const since = adjustmentReference(c), due = plusYear(since), left = daysBetween(today, due);
    if (c.endAt && c.endAt < due) continue; // o contrato acaba antes do aniversário: não há o que reajustar
    if (left <= 0) out.push({ contractId: c.id, customerName: c.customerName, kind: "reajuste_atrasado", date: due, days: Math.abs(left), amountCents: c.amountCents, since });
    else if (left <= windowDays) out.push({ contractId: c.id, customerName: c.customerName, kind: "reajuste_proximo", date: due, days: left, amountCents: c.amountCents, since });
  }
  const rank: Record<AlertKind, number> = { vigencia_encerrada: 0, reajuste_atrasado: 1, vigencia_proxima: 2, reajuste_proximo: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind.endsWith("proxima") || a.kind.endsWith("proximo") ? a.days - b.days : b.days - a.days) || a.customerName.localeCompare(b.customerName, "pt-BR"));
}

const manausDay = (d: Date | null) => (d ?? new Date()).toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });

export async function listContractAlerts(db: DB, actorId: string, companyId: string, today: string, windowDays: number = DEFAULT_WINDOW) {
  await requirePerm(db, actorId, companyId, "contracts.read");
  const rows = await db.select({ c: contracts, name: customers.legalName }).from(contracts)
    .innerJoin(customers, and(eq(customers.id, contracts.customerId), eq(customers.companyId, contracts.companyId)))
    .where(and(eq(contracts.companyId, companyId), inArray(contracts.status, ["ativo", "suspenso"]))).orderBy(asc(customers.legalName));
  const versions = rows.length ? await db.select({ contractId: contractVersions.contractId, terms: contractVersions.terms, decidedAt: contractVersions.decidedAt }).from(contractVersions)
    .where(and(eq(contractVersions.companyId, companyId), eq(contractVersions.state, "aprovada"), inArray(contractVersions.contractId, rows.map((r) => r.c.id)))).orderBy(asc(contractVersions.contractId), asc(contractVersions.version)) : [];
  const byContract = new Map<string, AlertInput["approved"]>();
  for (const v of versions) {
    const cents = (v.terms as { monthlyAmountCents?: number }).monthlyAmountCents;
    if (typeof cents !== "number") continue;
    (byContract.get(v.contractId) ?? byContract.set(v.contractId, []).get(v.contractId)!).push({ cents, on: manausDay(v.decidedAt) });
  }
  const alerts = contractAlerts(rows.map((r) => ({ id: r.c.id, customerName: r.name, status: r.c.status, startAt: r.c.startAt, endAt: r.c.endAt, amountCents: centsFromNumeric(r.c.monthlyAmount), approved: byContract.get(r.c.id) ?? [] })), today, windowDays);
  return { alerts, checked: rows.length };
}
