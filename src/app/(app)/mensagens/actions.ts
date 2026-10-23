"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { activateVersion, ensureDefaultTemplates, processQueue, saveDraft, saveSettings, scheduleQueue } from "@/modules/messaging/service";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const go = (path: string, err = "", ok = "") => redirect(`${path}${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${encodeURIComponent(ok)}` : ""}`);

export async function scheduleAction() {
  let err = "", ok = "";
  try { const c = await ctx(); const r = await scheduleQueue(db, c.userId, c.companyId); ok = `programado:${r.created}:${r.blocked}:${r.semModelo}:${r.passado}:${r.cancelled}`; } catch (e) { err = known(e); }
  revalidatePath("/mensagens"); go("/mensagens", err, ok);
}
export async function processAction() {
  let err = "", ok = "";
  try { const c = await ctx(); const r = await processQueue(db, c.userId, c.companyId); ok = `processado:${r.processed}:${r.cancelled}:${r.blocked}:${r.failed}:${r.skipped}${r.waiting ? ":" + encodeURIComponent(r.waiting) : ""}`; } catch (e) { err = known(e); }
  revalidatePath("/mensagens"); go("/mensagens", err, ok);
}
export async function defaultsAction() {
  let err = "", ok = "";
  try { const c = await ctx(); const r = await ensureDefaultTemplates(db, c.userId, c.companyId); ok = `padroes:${r.created}`; } catch (e) { err = known(e); }
  revalidatePath("/mensagens/modelos"); go("/mensagens/modelos", err, ok);
}
export async function saveDraftAction(fd: FormData) {
  const kind = String(fd.get("kind") ?? ""), channel = String(fd.get("channel") ?? "");
  let err = "";
  try { const c = await ctx(); await saveDraft(db, c.userId, c.companyId, kind, channel, String(fd.get("subject") ?? ""), String(fd.get("body") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/mensagens/modelos"); go(`/mensagens/modelos/${encodeURIComponent(kind)}/${encodeURIComponent(channel)}`, err, "rascunho");
}
export async function activateAction(fd: FormData) {
  const kind = String(fd.get("kind") ?? ""), channel = String(fd.get("channel") ?? "");
  let err = "";
  try { const c = await ctx(); await activateVersion(db, c.userId, c.companyId, String(fd.get("versionId") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/mensagens/modelos"); go(`/mensagens/modelos/${encodeURIComponent(kind)}/${encodeURIComponent(channel)}`, err, "ativada");
}
export async function saveSettingsAction(fd: FormData) {
  let err = "";
  const on = (k: string) => fd.get(k) === "on";
  try {
    const c = await ctx();
    await saveSettings(db, c.userId, c.companyId, {
      paused: on("paused"), autoDispatch: on("autoDispatch"), emailEnabled: on("emailEnabled"), whatsappEnabled: on("whatsappEnabled"), skipHolidays: on("skipHolidays"),
      windowStart: String(fd.get("windowStart") ?? ""), windowEnd: String(fd.get("windowEnd") ?? ""), weekdays: fd.getAll("weekdays").map(Number),
      maxPerRun: String(fd.get("maxPerRun") ?? ""), maxPerHour: String(fd.get("maxPerHour") ?? ""), maxLateDays: String(fd.get("maxLateDays") ?? ""),
    });
  } catch (e) { err = known(e); }
  revalidatePath("/mensagens"); go("/mensagens/configuracao", err, "salvo");
}
