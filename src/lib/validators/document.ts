export type DocType = "cpf" | "cnpj";

const clean = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");
const val = (c: string) => c.charCodeAt(0) - 48; // regra RFB: dígito = código ASCII - 48 (permite CNPJ alfanumérico)

function dv(base: string, weights: number[]): number {
  const r = [...base].reduce((s, c, i) => s + val(c) * weights[i], 0) % 11;
  return r < 2 ? 0 : 11 - r;
}

export function validateCpf(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const w1 = [10, 9, 8, 7, 6, 5, 4, 3, 2], w2 = [11, ...w1];
  return dv(d.slice(0, 9), w1) === +d[9] && dv(d.slice(0, 10), w2) === +d[10];
}

/** CNPJ numérico ou alfanumérico (12 posições [0-9A-Z] + 2 dígitos verificadores numéricos). */
export function validateCnpj(raw: string): boolean {
  const c = clean(raw);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], w2 = [6, ...w1];
  return dv(c.slice(0, 12), w1) === +c[12] && dv(c.slice(0, 13), w2) === +c[13];
}

/** Normaliza e valida. Retorna o documento sem pontuação, ou null se inválido. */
export function parseDocument(raw: string): { type: DocType; digits: string } | null {
  const c = clean(raw);
  if (/^\d{11}$/.test(c)) return validateCpf(c) ? { type: "cpf", digits: c } : null;
  if (c.length === 14) return validateCnpj(c) ? { type: "cnpj", digits: c } : null;
  return null;
}

export function formatDocument(type: DocType, d: string): string {
  return type === "cpf"
    ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4")
    : d.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
}
