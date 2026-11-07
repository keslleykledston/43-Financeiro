import { addDays } from "@/modules/messaging/dates";
import { isWeekend, type HolidayMap } from "./calendar";

/** F1 — datas do faturamento automático (funções PURAS). Dia útil = nem fim de semana nem feriado (nacional + os da empresa). */
export const isBusinessDay = (iso: string, hol: HolidayMap) => !isWeekend(iso) && !hol.has(iso);
/** Dia da EMISSÃO de fato: a data prevista, ou o dia útil anterior se ela cair em fim de semana ou feriado (o vencimento é fixo, então nunca se emite depois). */
export function runDateFor(issueDate: string, hol: HolidayMap): string {
  let d = issueDate;
  for (let i = 0; i < 15 && !isBusinessDay(d, hol); i++) d = addDays(d, -1);
  return d;
}
/** Dia em que a prévia deve estar pronta: `lead` dias ÚTEIS antes do dia da emissão. */
export function previewDateFor(runDate: string, lead: number, hol: HolidayMap): string {
  let d = runDate;
  for (let n = 0; n < lead; n++) { do { d = addDays(d, -1); } while (!isBusinessDay(d, hol)); }
  return d;
}
