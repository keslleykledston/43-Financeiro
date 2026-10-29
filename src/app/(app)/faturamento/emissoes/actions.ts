"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { cancelIssuance, getIssuanceSettings, processIssuance, requestBatchIssuance, saveIssuanceSettings } from "@/modules/issuance/service";
import { syncBoletoStatus } from "@/modules/issuance/sync";
import { LiveNotAvailable } from "@/modules/providers/registry";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden || e instanceof LiveNotAvailable) return e.message; throw e; };
const go = (err = "", ok = "") => redirect(`/faturamento/emissoes${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${encodeURIComponent(ok)}` : ""}`);

export async function requestBatchIssuanceAction(fd: FormData) {
  let err = "", ok = "";
  try { const c = await ctx(); const r = await requestBatchIssuance(db, c.userId, c.companyId, String(fd.get("batchId") ?? ""), String(fd.get("kind") ?? "")); ok = `solicitado:${r.created}`; } catch (e) { err = known(e); }
  revalidatePath("/faturamento/emissoes"); go(err, ok);
}
export async function processIssuanceAction(fd: FormData) {
  let err = "", ok = "";
  try {
    const c = await ctx();
    // Emissão REAL: cada rodada exige a confirmação marcada na tela (o servidor confere; não basta esconder o botão).
    if ((await getIssuanceSettings(db, c.userId, c.companyId)).boletoProvider === "cora_producao" && fd.get("confirmLive") !== "on") throw new Invalid("Marque a confirmação: são boletos REAIS");
    const r = await processIssuance(db, c.userId, c.companyId, new Date(), undefined, { confirmLive: fd.get("confirmLive") === "on" }); ok = `rodada:${r.issued}:${r.processing}:${r.unknown}:${r.retry}:${r.failed}:${r.skipped}${r.waiting ? ":" + encodeURIComponent(r.waiting) : ""}`; } catch (e) { err = known(e); }
  revalidatePath("/faturamento/emissoes"); go(err, ok);
}
export async function syncBoletoStatusAction() {
  let err = "", ok = "";
  try { const c = await ctx(); const r = await syncBoletoStatus(db, c.userId, c.companyId); ok = `sync:${r.checked}:${r.paid}:${r.cancelled}:${r.failed}:${r.settled}:${r.needsReview}${r.skipped ? ":" + encodeURIComponent(r.skipped) : ""}`; } catch (e) { err = known(e); }
  revalidatePath("/faturamento/emissoes"); go(err, ok);
}
export async function cancelIssuanceAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await cancelIssuance(db, c.userId, c.companyId, String(fd.get("id") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/emissoes"); go(err, "cancelado");
}
export async function saveIssuanceSettingsAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await saveIssuanceSettings(db, c.userId, c.companyId, { paused: fd.get("paused") === "on", dailyLimit: fd.get("dailyLimit"), boletoProvider: fd.get("boletoProvider") ?? undefined, autoSettle: fd.has("autoSettleField") ? fd.get("autoSettle") === "on" : undefined, liveConfirm: String(fd.get("liveConfirm") ?? ""), liveCanary: fd.has("liveCanaryField") ? fd.get("liveCanary") === "on" : undefined }); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/emissoes"); go(err, "salvo");
}
