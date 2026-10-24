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

export type DocCheck =
  | { state: "vazio" }
  | { state: "incompleto"; digits: number }
  | { state: "valido"; type: DocType; digits: string; formatted: string }
  | { state: "invalido"; message: string; suggestions: { digits: string; formatted: string; why: string }[] };

/** Dígitos verificadores corretos para os 12 primeiros caracteres de um CNPJ. */
function cnpjWith(base12: string): string {
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], w2 = [6, ...w1];
  const d1 = dv(base12, w1);
  return base12 + d1 + dv(base12 + d1, w2);
}

/** Confere o que a pessoa digitou e, se não bate, sugere o provável erro de digitação (dígitos verificadores trocados ou recalculados). PURO: serve ao navegador e ao servidor. */
export function checkDocument(raw: string): DocCheck {
  const c = clean(raw);
  if (!c) return { state: "vazio" };
  if (c.length < 11 || (c.length > 11 && c.length < 14)) return { state: "incompleto", digits: c.length };
  const ok = parseDocument(c);
  if (ok) return { state: "valido", type: ok.type, digits: ok.digits, formatted: formatDocument(ok.type, ok.digits) };
  const suggestions: { digits: string; formatted: string; why: string }[] = [];
  const add = (digits: string, why: string) => { if (digits !== c && parseDocument(digits) && !suggestions.some((s) => s.digits === digits)) suggestions.push({ digits, formatted: formatDocument(digits.length === 11 ? "cpf" : "cnpj", digits), why }); };
  if (c.length === 14) {
    add(c.slice(0, 12) + c[13] + c[12], "dígitos verificadores trocados de lugar");
    add(cnpjWith(c.slice(0, 12)), "dígitos verificadores recalculados (confira se os 12 primeiros estão certos)");
  } else if (c.length === 11 && /^\d+$/.test(c)) {
    add(c.slice(0, 9) + c[10] + c[9], "dígitos verificadores trocados de lugar");
  }
  const what = c.length === 11 ? "CPF" : "CNPJ";
  return { state: "invalido", message: /^(.)\1+$/.test(c) ? `${what} com todos os dígitos iguais não existe` : `Os dígitos verificadores do ${what} não conferem: provável erro de digitação`, suggestions };
}
