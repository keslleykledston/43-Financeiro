import { daysBetween } from "@/modules/receivables/status";

/** E11 — situação de uma conta a pagar. PURO: "paga" e "parcial" são sempre calculados a partir das baixas, nunca guardados. */
export type State = "rascunho" | "aguardando_aprovacao" | "aprovado" | "rejeitado" | "cancelado";
export type Situation = "rascunho" | "aguardando" | "a_vencer" | "vencida" | "parcial" | "paga" | "rejeitada" | "cancelada";
export const SITUATION_LABEL: Record<Situation, string> = { rascunho: "Rascunho", aguardando: "Aguardando aprovação", a_vencer: "Aprovada · a vencer", vencida: "Aprovada · vencida", parcial: "Parcialmente paga", paga: "Paga", rejeitada: "Rejeitada", cancelada: "Cancelada" };

export function payableSituation(i: { status: string; amountCents: number; paidCents: number; dueDate: string; today: string }) {
  const open = Math.max(0, i.amountCents - i.paidCents);
  const late = Math.max(0, daysBetween(i.dueDate, i.today)); // vence hoje ainda não é atraso
  let situation: Situation;
  switch (i.status) {
    case "rascunho": situation = "rascunho"; break;
    case "aguardando_aprovacao": situation = "aguardando"; break;
    case "rejeitado": situation = "rejeitada"; break;
    case "cancelado": situation = "cancelada"; break;
    default: situation = open === 0 ? "paga" : i.paidCents > 0 ? "parcial" : late > 0 ? "vencida" : "a_vencer";
  }
  const counts = (i.status === "aprovado" && open > 0) || i.status === "aguardando_aprovacao"; // o que ainda pode vencer
  return { situation, openCents: i.status === "aprovado" ? open : i.status === "aguardando_aprovacao" ? i.amountCents : 0, overdueDays: counts ? late : 0, payable: i.status === "aprovado" && open > 0 };
}

export const METHODS = ["pix", "boleto", "ted", "transferencia", "outro"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<Method, string> = { pix: "Pix", boleto: "Boleto", ted: "TED", transferencia: "Transferência", outro: "Outro" };

export const FILTERS = ["abertas", "aguardando", "aprovadas", "vencidas", "pagas", "rascunhos", "encerradas", "todas"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_LABEL: Record<Filter, string> = { abertas: "Em aberto", aguardando: "Aguardando aprovação", aprovadas: "Aprovadas a pagar", vencidas: "Vencidas", pagas: "Pagas", rascunhos: "Rascunhos", encerradas: "Rejeitadas/canceladas", todas: "Todas" };
