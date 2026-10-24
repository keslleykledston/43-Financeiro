/** Formatadores únicos do K3G Finance (portados do protótipo). Dinheiro SEMPRE em centavos inteiros. */
export type Cents = number;
export const TIMEZONE = "America/Manaus";

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** 123456 → "R$ 1.234,56" (espaço normal, não NBSP). */
export function formatBRL(cents: Cents): string {
  if (!Number.isInteger(cents)) throw new Error("formatBRL espera centavos inteiros");
  return brl.format(cents / 100).replace(/ /g, " ");
}
/** ISO/Date → "dd/mm/aaaa" no fuso America/Manaus. Data só com dia ("2026-01-01", colunas `date`) é data de calendário: não sofre conversão de fuso (senão apareceria 31/12/2025). */
export const formatDate = (d: string | Date) => {
  const m = typeof d === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : dateFmt.format(new Date(d));
};
export const formatDateTime = (d: string | Date) => dateTimeFmt.format(new Date(d)).replace(",", " ·");
/** 0.124 → "+12,4%" */
export function formatPct(ratio: number): string {
  return `${ratio > 0 ? "+" : ""}${(ratio * 100).toFixed(1).replace(".", ",")}%`;
}
