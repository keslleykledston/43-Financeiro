import { holidaysFor, type HolidayMap } from "@/modules/billing/calendar";

/** E09 — janela de envio. Funções PURAS; o fuso é sempre America/Manaus. */
export type WindowSettings = { windowStart: string; windowEnd: string; weekdays: number[]; skipHolidays: boolean };
export type WindowState = { open: true } | { open: false; reason: "fora_do_horario" | "dia_nao_permitido" | "feriado" };
export const WINDOW_REASON: Record<Exclude<WindowState, { open: true }>["reason"], string> = {
  fora_do_horario: "Fora do horário permitido", dia_nao_permitido: "Dia da semana não permitido", feriado: "Feriado",
};

const TZ = "America/Manaus";
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Data local (AAAA-MM-DD), minutos desde 00:00 e dia da semana (0=domingo) no fuso da operação. */
export function localParts(now: Date): { date: string; minutes: number; dow: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute, dow: WD[p.weekday] };
}
const toMin = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);

export function windowState(now: Date, s: WindowSettings, companyHolidays: HolidayMap = new Map()): WindowState {
  const l = localParts(now);
  if (!s.weekdays.includes(l.dow)) return { open: false, reason: "dia_nao_permitido" };
  if (s.skipHolidays && holidaysFor([l.date], companyHolidays).has(l.date)) return { open: false, reason: "feriado" };
  if (l.minutes < toMin(s.windowStart) || l.minutes >= toMin(s.windowEnd)) return { open: false, reason: "fora_do_horario" };
  return { open: true };
}

export const DEFAULT_SETTINGS = {
  paused: false, autoDispatch: false, emailEnabled: true, whatsappEnabled: false, windowStart: "09:00", windowEnd: "18:00",
  weekdays: [1, 2, 3, 4, 5], skipHolidays: true, maxPerRun: 50, maxPerHour: 30, maxLateDays: 2,
};
export type MessagingSettings = typeof DEFAULT_SETTINGS;

/** Valida e normaliza a configuração vinda do formulário. */
export function parseSettings(raw: Partial<Record<keyof MessagingSettings, unknown>>): { ok: true; value: MessagingSettings } | { ok: false; error: string } {
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const start = String(raw.windowStart ?? ""), end = String(raw.windowEnd ?? "");
  if (!hhmm.test(start) || !hhmm.test(end)) return { ok: false, error: "Horário inválido (use HH:MM)" };
  if (start >= end) return { ok: false, error: "O horário final deve ser depois do inicial" };
  const weekdays = [...new Set((Array.isArray(raw.weekdays) ? raw.weekdays : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (weekdays.length === 0) return { ok: false, error: "Marque ao menos um dia da semana" };
  const num = (v: unknown, lo: number, hi: number, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new RangeError(`${name}: valor entre ${lo} e ${hi}`); return n; };
  try {
    return { ok: true, value: {
      paused: raw.paused === true, autoDispatch: raw.autoDispatch === true, emailEnabled: raw.emailEnabled === true, whatsappEnabled: raw.whatsappEnabled === true,
      windowStart: start, windowEnd: end, weekdays, skipHolidays: raw.skipHolidays === true,
      maxPerRun: num(raw.maxPerRun, 1, 500, "Limite por execução"), maxPerHour: num(raw.maxPerHour, 1, 2000, "Limite por hora"), maxLateDays: num(raw.maxLateDays, 0, 30, "Dias de tolerância"),
    } };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
