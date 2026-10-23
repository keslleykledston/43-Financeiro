import { addDays } from "@/modules/messaging/dates";
import { addMonths } from "@/modules/billing/calendar";
import { daysBetween } from "@/modules/receivables/status";

/** E12 — cálculos PUROS do painel (datas ISO, centavos inteiros). Nenhuma tela recalcula fórmula: tudo passa por aqui. */
export const WEEKS = 13;

/** Segunda-feira da semana de `iso` (semana começa na segunda). */
export function weekStart(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=domingo
  return addDays(iso, -((dow + 6) % 7));
}
export const horizonEnd = (today: string) => addDays(weekStart(today), WEEKS * 7 - 1);

/** Índice (0..12) da semana de `due` dentro do horizonte, ou null se fora. */
export function weekIndex(today: string, due: string): number | null {
  const d = daysBetween(weekStart(today), due);
  if (d < 0) return null;
  const i = Math.floor(d / 7);
  return i < WEEKS ? i : null;
}

export type Quality = "alta" | "media";
export const QUALITY_LABEL: Record<Quality, string> = { alta: "Alta: cobranças aprovadas com vencimento conhecido", media: "Média: previsto pelos contratos, ainda não emitido" };

export type ForecastWeek = { start: string; end: string; confirmedCents: number; plannedCents: number };
/**
 * Fluxo de ENTRADAS projetado em 13 semanas. `open` = cobranças aprovadas em aberto (saldo, vencimento); `planned` = cobranças ainda não emitidas previstas pelos contratos.
 * Vencido (due < hoje) NÃO é projetado como recebimento: fica em `overdueCents` à parte (sem inventar probabilidade de pagamento).
 */
export function buildForecast(today: string, open: { dueDate: string; cents: number }[], planned: { dueDate: string; cents: number }[]) {
  const ws = weekStart(today);
  const weeks: ForecastWeek[] = Array.from({ length: WEEKS }, (_, i) => ({ start: addDays(ws, i * 7), end: addDays(ws, i * 7 + 6), confirmedCents: 0, plannedCents: 0 }));
  let overdueCents = 0, beyondCents = 0, plannedOverdueCount = 0;
  for (const o of open) {
    if (o.dueDate < today) { overdueCents += o.cents; continue; }
    const i = weekIndex(today, o.dueDate);
    if (i === null) beyondCents += o.cents; else weeks[i].confirmedCents += o.cents;
  }
  for (const p of planned) {
    if (p.dueDate < today) { plannedOverdueCount++; continue; }
    const i = weekIndex(today, p.dueDate);
    if (i !== null) weeks[i].plannedCents += p.cents;
  }
  const sum = (k: "confirmedCents" | "plannedCents") => weeks.reduce((s, w) => s + w[k], 0);
  return { weeks, overdueCents, beyondCents, plannedOverdueCount, totals: { confirmedCents: sum("confirmedCents"), plannedCents: sum("plannedCents") }, end: horizonEnd(today) };
}

/** Últimos `n` meses terminando em `month` (AAAA-MM), do mais antigo ao atual. */
export const lastMonths = (month: string, n: number) => Array.from({ length: n }, (_, i) => addMonths(month, i - (n - 1)));

export type Severity = "critical" | "warning" | "info" | "positive";
export type Alert = { key: string; severity: Severity; title: string; detail: string; href: string };
export type AlertInput = {
  overdueCents: number; overdueCount: number; openCents: number; over30Cents: number;
  draftBatches: { id: string; issueDate: string }[]; dueSoonCount: number;
  pendingCredits: number; accounts: number; daysSinceLastTx: number | null;
  blockedMessages: number; failedIssuance: number; customersNoContact: number; customersNoContract: number; plannedOverdueCount: number;
};
const n = (v: number, one: string, many: string) => `${v} ${v === 1 ? one : many}`;
export const DELINQUENCY_CRITICAL = 0.1;

/** Regras do painel (limiares simples e rastreáveis; sem IA). Cada alerta leva ao lugar onde se resolve. */
export function buildAlerts(i: AlertInput, today: string): Alert[] {
  const out: Alert[] = [];
  const ratio = i.openCents > 0 ? i.overdueCents / i.openCents : 0;
  if (i.overdueCount > 0) {
    out.push({ key: "overdue", severity: i.over30Cents > 0 || ratio >= DELINQUENCY_CRITICAL ? "critical" : "warning", title: `${n(i.overdueCount, "cobrança vencida", "cobranças vencidas")}`, detail: i.over30Cents > 0 ? "Há valores vencidos há mais de 30 dias." : `${Math.round(ratio * 100)}% do valor em aberto está vencido.`, href: "/contas-a-receber?status=vencidas" });
  } else if (i.openCents > 0) {
    out.push({ key: "no-overdue", severity: "positive", title: "Nenhuma cobrança vencida", detail: "Todas as cobranças em aberto estão dentro do prazo.", href: "/contas-a-receber" });
  }
  for (const b of i.draftBatches) {
    const d = daysBetween(today, b.issueDate);
    out.push({ key: `batch-${b.id}`, severity: d < 0 ? "critical" : "warning", title: `Lote de emissão ${b.issueDate.split("-").reverse().join("/")} ainda em prévia`, detail: d < 0 ? `A data de emissão passou há ${-d} dia(s) e o lote não foi aprovado.` : d === 0 ? "A emissão é hoje e o lote ainda não foi aprovado." : `Emissão em ${d} dia(s): falta aprovar.`, href: `/faturamento/lotes/${b.id}` });
  }
  if (i.plannedOverdueCount > 0) out.push({ key: "missing-charges", severity: "warning", title: `${n(i.plannedOverdueCount, "cobrança prevista por contrato", "cobranças previstas por contrato")} com vencimento passado e sem emissão`, detail: "O contrato previa cobrança, mas nenhum lote foi gerado e aprovado para a competência.", href: "/faturamento/lotes" });
  if (i.dueSoonCount > 0) out.push({ key: "due-soon", severity: "info", title: `${n(i.dueSoonCount, "cobrança vence", "cobranças vencem")} em até 3 dias`, detail: "Acompanhe os pagamentos ou a régua de mensagens.", href: "/contas-a-receber?status=a_vencer" });
  if (i.accounts > 0 && i.pendingCredits > 0) out.push({ key: "reconcile", severity: "info", title: `${n(i.pendingCredits, "crédito", "créditos")} a conciliar`, detail: "Entradas do extrato ainda sem cobrança vinculada.", href: "/conciliacao" });
  if (i.accounts > 0 && (i.daysSinceLastTx === null || i.daysSinceLastTx > 7)) out.push({ key: "stale-statement", severity: "warning", title: "Extrato bancário desatualizado", detail: i.daysSinceLastTx === null ? "Nenhuma transação importada ainda." : `A última transação importada tem ${i.daysSinceLastTx} dias.`, href: "/conciliacao" });
  if (i.blockedMessages > 0) out.push({ key: "blocked-msgs", severity: "info", title: `${n(i.blockedMessages, "mensagem bloqueada", "mensagens bloqueadas")}`, detail: "Falta contato financeiro ou houve falha de envio.", href: "/mensagens?status=bloqueado" });
  if (i.failedIssuance > 0) out.push({ key: "failed-issuance", severity: "warning", title: `${n(i.failedIssuance, "emissão com falha", "emissões com falha")}`, detail: "Revise no provedor (simulado) antes de repetir.", href: "/faturamento/emissoes?status=falhou" });
  if (i.customersNoContract > 0) out.push({ key: "no-contract", severity: "info", title: `${n(i.customersNoContract, "cliente ativo", "clientes ativos")} sem contrato`, detail: "Sem contrato aprovado não há cobrança nem previsão de receita.", href: "/contratos" });
  if (i.customersNoContact > 0) out.push({ key: "no-contact", severity: "info", title: `${n(i.customersNoContact, "cliente ativo", "clientes ativos")} sem contato financeiro com e-mail`, detail: "As mensagens da régua ficam bloqueadas.", href: "/clientes" });
  const rank = { critical: 0, warning: 1, info: 2, positive: 3 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
