/** E18 — comissões de parceiros. Funções PURAS (sem banco). Dinheiro em centavos inteiros; percentual em pontos-base (3000 = 30%). */
export const MAX_BPS = 10000;

/** Comissão = valor-base × percentual, arredondada ao centavo (metade para cima). BigInt: base × bps passa de 2^53 em valores altos. */
export function commissionCents(baseCents: number, bps: number): number {
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0 || !Number.isInteger(bps) || bps < 1 || bps > MAX_BPS) throw new RangeError("comissão: base ou percentual inválido");
  return Number((BigInt(baseCents) * BigInt(bps) + 5000n) / 10000n);
}

/** "30", "30%", "12,5", "12.5" → 3000, 1250. Aceita até 2 casas; 0 e acima de 100 são inválidos. */
export function parsePercent(raw: string): number | null {
  const s = raw.trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps >= 1 && bps <= MAX_BPS ? bps : null;
}

export const percentLabel = (bps: number) => `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`;

/** Mês (YYYY-MM) anterior ao dia informado: o mês que se paga no dia 16 do mês corrente. */
export function previousMonth(today: string): string {
  const [y, m] = today.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Dia do pagamento da comissão dos recebimentos do mês `month` (YYYY-MM): 16 do mês seguinte. */
export function payDateOf(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-16` : `${y}-${String(m + 1).padStart(2, "0")}-16`;
}
