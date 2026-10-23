import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, localParts, parseSettings, windowState } from "@/modules/messaging/window";

// Manaus = UTC−4 (sem horário de verão). 2026-10-01 é quinta-feira.
const at = (iso: string) => new Date(`${iso}-04:00`);
const S = { windowStart: "09:00", windowEnd: "18:00", weekdays: [1, 2, 3, 4, 5], skipHolidays: true };

describe("E09 janela de envio (regras puras)", () => {
  it("converte para o fuso de Manaus (data, minutos e dia da semana)", () => {
    expect(localParts(new Date("2026-10-02T02:30:00Z"))).toEqual({ date: "2026-10-01", minutes: 22 * 60 + 30, dow: 4 }); // 22:30 de quinta em Manaus
    expect(localParts(new Date("2026-10-04T03:59:00Z"))).toMatchObject({ date: "2026-10-03", dow: 6 });
  });
  it("abre só em dia útil permitido, dentro do horário (fim exclusivo)", () => {
    expect(windowState(at("2026-10-01T09:00:00"), S)).toEqual({ open: true });
    expect(windowState(at("2026-10-01T17:59:00"), S)).toEqual({ open: true });
    expect(windowState(at("2026-10-01T18:00:00"), S)).toEqual({ open: false, reason: "fora_do_horario" });
    expect(windowState(at("2026-10-01T08:59:00"), S)).toEqual({ open: false, reason: "fora_do_horario" });
    expect(windowState(at("2026-10-03T10:00:00"), S)).toEqual({ open: false, reason: "dia_nao_permitido" }); // sábado
    expect(windowState(at("2026-10-04T10:00:00"), S)).toEqual({ open: false, reason: "dia_nao_permitido" }); // domingo
  });
  it("feriado nacional e municipal fecham a janela (se configurado)", () => {
    expect(windowState(at("2026-11-02T10:00:00"), S)).toEqual({ open: false, reason: "feriado" }); // Finados (segunda)
    expect(windowState(at("2026-11-02T10:00:00"), { ...S, skipHolidays: false })).toEqual({ open: true });
    expect(windowState(at("2026-10-01T10:00:00"), S, new Map([["2026-10-01", "Feriado municipal"]]))).toEqual({ open: false, reason: "feriado" });
  });
  it("a data/hora é a de Manaus, não a de UTC", () => {
    // 21:30 em Manaus de quinta = sexta 01:30Z: fora do horário, e não "sexta de manhã"
    expect(windowState(new Date("2026-10-02T01:30:00Z"), S)).toEqual({ open: false, reason: "fora_do_horario" });
  });
  it("validação da configuração", () => {
    const ok = parseSettings({ ...DEFAULT_SETTINGS });
    expect(ok.ok).toBe(true);
    expect(parseSettings({ ...DEFAULT_SETTINGS, windowEnd: "09:00" })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, windowStart: "9:00" })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, windowEnd: "24:00" })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, weekdays: [] })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, weekdays: [9, -1] })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, maxPerRun: 0 })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, maxPerHour: 2001 })).toMatchObject({ ok: false });
    expect(parseSettings({ ...DEFAULT_SETTINGS, maxLateDays: "x" })).toMatchObject({ ok: false });
    const r = parseSettings({ ...DEFAULT_SETTINGS, weekdays: [3, 1, 1, 2], whatsappEnabled: "true" });
    expect(r).toMatchObject({ ok: true, value: { weekdays: [1, 2, 3], whatsappEnabled: false } }); // só booleano verdadeiro liga
  });
  it("padrões conservadores: automático e WhatsApp desligados, seg–sex 09–18", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ paused: false, autoDispatch: false, whatsappEnabled: false, windowStart: "09:00", windowEnd: "18:00", weekdays: [1, 2, 3, 4, 5], skipHolidays: true });
  });
});
