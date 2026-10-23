/** Dinheiro em centavos inteiros (nunca float). Entrada pt-BR estrita para evitar ambiguidade ("2.500" = 2500, "2500.50" é recusado). */
const BR = /^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/;

export function parseMoneyToCents(raw: string): number | null {
  const s = raw.trim().replace(/^R\$\s*/, "");
  if (!BR.test(s)) return null;
  const [int, dec = ""] = s.replace(/\./g, "").split(",");
  const cents = Number(int) * 100 + Number((dec + "00").slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}
/** numeric(18,2) do Postgres ("2500.00") → centavos, sem passar por ponto flutuante. */
export function centsFromNumeric(v: string): number {
  const [i, d = ""] = v.split(".");
  return Number(i) * 100 + Number((d + "00").slice(0, 2));
}
export const numericFromCents = (c: number): string => `${Math.trunc(c / 100)}.${String(Math.abs(c % 100)).padStart(2, "0")}`;
