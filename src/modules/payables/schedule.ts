/** D2 — datas de recorrências e parcelas. PURO (sem banco). Meses curtos usam o último dia ("dia 31" em fevereiro = 28/29). */
export const isMonth = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** "2026-02", 31 → "2026-02-28". */
export function dueDateIn(month: string, day: number): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  return `${month}-${String(Math.min(Math.max(1, day), daysInMonth(y, m))).padStart(2, "0")}`;
}
export function addMonths(month: string, n: number): string {
  const t = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** Vencimentos das parcelas 1..n: mesmo dia do primeiro vencimento, a cada mês (com o ajuste de mês curto). */
export function seriesSchedule(firstDue: string, n: number): string[] {
  const day = Number(firstDue.slice(8, 10)), m0 = firstDue.slice(0, 7);
  return Array.from({ length: n }, (_, k) => dueDateIn(addMonths(m0, k), day));
}
export const monthOf = (iso: string) => iso.slice(0, 7);
export const firstOf = (month: string) => `${month}-01`;
