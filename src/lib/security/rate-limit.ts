// Limitador em memória (1 instância). Trocar por tabela no DB se escalar o web.
const hits = new Map<string, { n: number; reset: number }>();

export function tooManyAttempts(key: string, max = 5, windowMs = 15 * 60_000, now = Date.now()): boolean {
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  h.n += 1;
  return h.n > max;
}
export function clearAttempts(key: string) { hits.delete(key); }
