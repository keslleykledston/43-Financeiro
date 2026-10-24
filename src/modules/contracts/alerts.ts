import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/lib/db";
import { contracts, contractVersions, customers } from "@/lib/db/schema";
import { centsFromNumeric } from "@/lib/money";
import { requirePerm } from "@/modules/identity/service";

/**
 * Alertas de contrato (E17): regra de negócio — todo contrato vale 12 meses e RENOVA SOZINHO a cada 12 meses se o cliente não se
 * manifestar. Logo, "sem data final" = renovação automática; uma data final só existe quando o cliente (ou a K3G) encerrou.
 * Alertas: fim informado (próximo ou já passado), renovação automática próxima e reajuste (12 meses desde o início ou desde a última
 * mudança de valor aprovada). Só leitura: nada é alterado nem enviado; quem decide é a pessoa, pelo fluxo de alteração de contrato.
 */
export type AlertKind = "vigencia_encerrada" | "vigencia_proxima" | "renovacao_proxima" | "reajuste_atrasado" | "reajuste_proximo";
export const ALERT_LABEL: Record<AlertKind, string> = {
  vigencia_encerrada: "Fim informado já passou", vigencia_proxima: "Fim informado se aproxima", renovacao_proxima: "Renovação automática", reajuste_atrasado: "Reajuste em atraso", reajuste_proximo: "Reajuste se aproxima",
};
export const WINDOWS = [30, 60, 90] as const;
export const DEFAULT_WINDOW = 60;

export type AlertInput = {
  id: string; customerName: string; status: string; startAt: string; endAt: string | null; amountCents: number;
  /** valores mensais das versões APROVADAS, da mais antiga à mais nova, com a data (YYYY-MM-DD) da aprovação */
  approved: { cents: number; on: string }[];
};
export type ContractAlert = { contractId: string; customerName: string; kind: AlertKind; date: string; days: number; amountCents: number; since?: string; withAdjustment?: boolean };

const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / 86400000);

/** Mesma data um ano depois (29/02 → 28/02 em ano não bissexto). */
export function plusYear(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Mesma data N anos depois (a partir da data original, para 29/02 voltar a 29/02 em ano bissexto). */
export function plusYears(d: string, n: number): string {
  const [y, m, day] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${y + n}-${String(m).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** Próxima renovação automática: o primeiro aniversário do início (12, 24, 36… meses) que cai hoje ou depois. */
export function nextRenewal(startAt: string, today: string): string {
  let n = 1;
  while (plusYears(startAt, n) < today) n++;
  return plusYears(startAt, n);
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
    // renovação automática: só existe enquanto não há data final até ela (suspenso também renova: a suspensão não encerra o contrato)
    const renewal = nextRenewal(c.startAt, today), rLeft = daysBetween(today, renewal);
    const renews = !c.endAt || c.endAt > renewal;
    // reajuste: só contrato ativo (suspenso não cobra) e que ainda exista depois do aniversário
    const since = adjustmentReference(c), due = plusYear(since), left = daysBetween(today, due);
    const adjustable = c.status === "ativo" && (!c.endAt || c.endAt > due);
    const mergedAdjust = adjustable && renews && due === renewal && left <= windowDays; // reajuste e renovação no mesmo dia (inclusive hoje): um aviso só
    if (renews && rLeft <= windowDays) out.push({ contractId: c.id, customerName: c.customerName, kind: "renovacao_proxima", date: renewal, days: rLeft, amountCents: c.amountCents, since, withAdjustment: mergedAdjust });
    if (!adjustable || mergedAdjust) continue;
    if (left <= 0) out.push({ contractId: c.id, customerName: c.customerName, kind: "reajuste_atrasado", date: due, days: Math.abs(left), amountCents: c.amountCents, since });
    else if (left <= windowDays) out.push({ contractId: c.id, customerName: c.customerName, kind: "reajuste_proximo", date: due, days: left, amountCents: c.amountCents, since });
  }
  const rank: Record<AlertKind, number> = { vigencia_encerrada: 0, reajuste_atrasado: 1, vigencia_proxima: 2, renovacao_proxima: 3, reajuste_proximo: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (/proxim[ao]$/.test(a.kind) ? a.days - b.days : b.days - a.days) || a.customerName.localeCompare(b.customerName, "pt-BR"));
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
