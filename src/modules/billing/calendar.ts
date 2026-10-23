/**
 * Calendário de faturamento pós-pago (PRD §4, confirmado pelo dono). Funções PURAS, testadas contra fixtures/billing_calendar_cases.json.
 * Competência M = mês do serviço; vencimento no mês M+1. Datas como "YYYY-MM-DD" (sem fuso: o calendário é operacional, America/Manaus).
 *
 * Emissão do boleto, conforme o dia de vencimento D (no mês do vencimento):
 *   1–12 sem NF conjunta → dia 25 do mês ANTERIOR ao do vencimento     1–12 com NF conjunta → dia 1
 *   13–16 → dia 1      17–22 → dia 8      23–30 → dia 15      31 → NEEDS_REVIEW (sem lote confirmado)
 * Mês curto (dia inexistente, ex.: 30/fev) → NEEDS_REVIEW, sem substituir o vencimento do contrato.
 * Feriado em dia ÚTIL na data de emissão → NEEDS_REVIEW (política pendente). Fim de semana → só aviso (como na fixture).
 */
export type Warning = "emissao_fim_de_semana" | "vencimento_fim_de_semana" | "vencimento_feriado" | "emissao_no_dia_do_vencimento";
export type CalendarInput = { competenceMonth: string; dueDay: number; jointInvoice: boolean; issueDayOverride?: number | null };
export type CalendarResult = {
  competenceMonth: string; dueMonth: string; dueDay: number; jointInvoice: boolean;
  dueDate?: string; issueDate?: string; batch?: 25 | 1 | 8 | 15 | null;
  review: boolean; reason?: string; warnings: Warning[];
};

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const pad = (n: number) => String(n).padStart(2, "0");

export function parseMonth(m: string): { y: number; mo: number } {
  const x = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(m);
  if (!x) throw new Error(`mês inválido: ${m}`);
  return { y: +x[1], mo: +x[2] };
}
export function addMonths(m: string, n: number): string {
  const { y, mo } = parseMonth(m); const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export const daysInMonth = (m: string) => { const { y, mo } = parseMonth(m); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };
const date = (m: string, d: number) => `${m}-${pad(d)}`;
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = domingo
export const isWeekend = (iso: string) => dow(iso) === 0 || dow(iso) === 6;

// ---------- feriados ----------
/** Páscoa (algoritmo de Meeus/Jones/Butcher). */
function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, mo - 1, day));
}
/** Feriados NACIONAIS. Municipais/estaduais são cadastrados por empresa (tabela `holidays`). Ponto facultativo (Carnaval etc.) não entra. */
export function nationalHolidays(y: number): Map<string, string> {
  const h = new Map<string, string>([
    [`${y}-01-01`, "Confraternização Universal"], [`${y}-04-21`, "Tiradentes"], [`${y}-05-01`, "Dia do Trabalho"], [`${y}-09-07`, "Independência"],
    [`${y}-10-12`, "Nossa Senhora Aparecida"], [`${y}-11-02`, "Finados"], [`${y}-11-15`, "Proclamação da República"], [`${y}-11-20`, "Consciência Negra"], [`${y}-12-25`, "Natal"],
  ]);
  const gf = easter(y); gf.setUTCDate(gf.getUTCDate() - 2);
  h.set(gf.toISOString().slice(0, 10), "Sexta-feira Santa");
  return h;
}
export type HolidayMap = Map<string, string>;
export const holidaysFor = (isoDates: string[], extra: HolidayMap = new Map()): HolidayMap => {
  const out: HolidayMap = new Map();
  for (const y of new Set(isoDates.map((d) => +d.slice(0, 4)))) for (const [k, v] of nationalHolidays(y)) out.set(k, v);
  for (const [k, v] of extra) out.set(k, v);
  return out;
};

// ---------- regra principal ----------
export function billingSchedule(inp: CalendarInput, extraHolidays: HolidayMap = new Map()): CalendarResult {
  const { competenceMonth, dueDay, jointInvoice } = inp;
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new Error(`dia de vencimento inválido: ${dueDay}`);
  const dueMonth = addMonths(competenceMonth, 1);
  const base: CalendarResult = { competenceMonth, dueMonth, dueDay, jointInvoice, review: false, warnings: [] };

  if (dueDay === 31) return { ...base, review: true, reason: "dia 31 não possui lote confirmado" };
  if (dueDay > daysInMonth(dueMonth)) return { ...base, review: true, reason: `dia ${dueDay} não existe em ${MESES[parseMonth(dueMonth).mo - 1]}; política pendente` };

  const dueDate = date(dueMonth, dueDay);
  let issueDate: string; let batch: CalendarResult["batch"];
  const ov = inp.issueDayOverride;
  if (ov) {
    if (!Number.isInteger(ov) || ov < 1 || ov > 28) throw new Error(`dia de emissão inválido: ${ov}`);
    if (ov > dueDay) return { ...base, dueDate, review: true, reason: "dia de emissão informado é posterior ao vencimento" };
    issueDate = date(dueMonth, ov); batch = null;
  } else if (dueDay <= 12 && !jointInvoice) { issueDate = date(addMonths(dueMonth, -1), 25); batch = 25; }
  else if (dueDay <= 16) { issueDate = date(dueMonth, 1); batch = 1; }
  else if (dueDay <= 22) { issueDate = date(dueMonth, 8); batch = 8; }
  else { issueDate = date(dueMonth, 15); batch = 15; }

  const hol = holidaysFor([issueDate, dueDate], extraHolidays);
  const warnings: Warning[] = [];
  if (isWeekend(issueDate)) warnings.push("emissao_fim_de_semana");
  if (isWeekend(dueDate)) warnings.push("vencimento_fim_de_semana");
  if (hol.has(dueDate)) warnings.push("vencimento_feriado");
  if (issueDate === dueDate) warnings.push("emissao_no_dia_do_vencimento");

  const holidayOnWeekday = hol.has(issueDate) && !isWeekend(issueDate);
  return { ...base, dueDate, issueDate, batch, warnings, review: holidayOnWeekday, ...(holidayOnWeekday ? { reason: "feriado; política pendente" } : {}) };
}

export const WARNING_LABEL: Record<Warning, string> = {
  emissao_fim_de_semana: "emissão em fim de semana", vencimento_fim_de_semana: "vencimento em fim de semana",
  vencimento_feriado: "vencimento em feriado", emissao_no_dia_do_vencimento: "emissão no próprio dia do vencimento",
};
