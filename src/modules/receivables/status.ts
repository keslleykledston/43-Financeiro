/** E07 — situação de uma cobrança a receber. Funções PURAS: o saldo é sempre calculado, nunca guardado como "flag". */
export type Situation = "quitada" | "parcial" | "vencida" | "a_vencer";
export const SITUATION_LABEL: Record<Situation, string> = { quitada: "Quitada", parcial: "Parcial", vencida: "Vencida", a_vencer: "A vencer" };

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function situationOf(i: { amountCents: number; paidCents: number; dueDate: string; today: string }) {
  const open = Math.max(0, i.amountCents - i.paidCents);
  const overdueDays = open > 0 ? Math.max(0, daysBetween(i.dueDate, i.today)) : 0; // vence hoje ainda não é atraso
  const situation: Situation = open === 0 ? "quitada" : i.paidCents > 0 ? "parcial" : overdueDays > 0 ? "vencida" : "a_vencer";
  return { openCents: open, situation, overdue: overdueDays > 0, overdueDays };
}

export const AGING = [
  { key: "1-15", label: "1 a 15 dias", min: 1, max: 15 },
  { key: "16-30", label: "16 a 30 dias", min: 16, max: 30 },
  { key: "31-60", label: "31 a 60 dias", min: 31, max: 60 },
  { key: "61+", label: "Mais de 60 dias", min: 61, max: Infinity },
] as const;
export const agingBucket = (days: number) => AGING.find((b) => days >= b.min && days <= b.max)?.key ?? null;

export const METHODS = ["pix", "boleto", "transferencia", "dinheiro", "outro"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<Method, string> = { pix: "Pix", boleto: "Boleto", transferencia: "Transferência", dinheiro: "Dinheiro", outro: "Outro" };

export const FILTERS = ["abertas", "a_vencer", "vencidas", "parciais", "quitadas", "todas"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_LABEL: Record<Filter, string> = { abertas: "Em aberto", a_vencer: "A vencer", vencidas: "Vencidas", parciais: "Parciais", quitadas: "Quitadas", todas: "Todas" };
