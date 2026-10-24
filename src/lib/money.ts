/** Dinheiro em centavos inteiros (nunca float). Entrada pt-BR estrita para evitar ambiguidade ("2.500" = 2500, "2500.50" é recusado). */
/** Teto de um valor: R$ 99.999.999.999,99. Somas de centenas de contratos continuam < Number.MAX_SAFE_INTEGER (alinhado ao CHECK do banco). */
export const MAX_CENTS = 9_999_999_999_999;
const BR = /^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/;

export function parseMoneyToCents(raw: string): number | null {
  const s = raw.trim().replace(/^R\$\s*/, "");
  if (!BR.test(s)) return null;
  const [int, dec = ""] = s.replace(/\./g, "").split(",");
  const cents = Number(int) * 100 + Number((dec + "00").slice(0, 2));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}
/** numeric(18,2) do Postgres ("2500.00") → centavos, sem passar por ponto flutuante. Falha alto se não couber com segurança. */
export function centsFromNumeric(v: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new RangeError("Valor monetário inválido");
  const [i, d = ""] = v.split(".");
  const cents = Number(i) * 100 + Number((d + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new RangeError("Valor monetário acima do limite suportado");
  return cents;
}
export function numericFromCents(c: number): string {
  if (!Number.isSafeInteger(c) || c < 0 || c > MAX_CENTS) throw new RangeError("Valor monetário fora do limite suportado");
  return `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

/** Centavos COM SINAL (ajustes que reduzem o valor) → numeric do Postgres. */
export function numericFromSignedCents(c: number): string {
  return c < 0 ? `-${numericFromCents(-c)}` : numericFromCents(c);
}
/** numeric com sinal → centavos. */
export function centsFromSignedNumeric(v: string): number {
  return v.startsWith("-") ? -centsFromNumeric(v.slice(1)) : centsFromNumeric(v);
}
