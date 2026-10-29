"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { assignTriage, discardTriage, markDispute, optOutFromInbox, setHandling } from "@/modules/whatsapp/inbound";
import { cancelOutbox, dispatchOutbox, queueCustomerMessage, resolveUnknown, saveCompanySettings } from "@/modules/whatsapp/outbound";
import { ensureWhatsappDefaults } from "@/modules/messaging/service";
import { bindCompany, createSession, disconnectSession, recordConsent, revokeAuthorization, saveAuthorization, sendTest, setPaused, settleStaleSends, startSession, unbindCompany } from "@/modules/whatsapp/service";

export type FormState = { error?: string; saved?: string; sessionId?: string } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const text = (fd: FormData, k: string, max: number) => String(fd.get(k) ?? "").slice(0, max);
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const back = (err: string, ok = "") => redirect(`/whatsapp${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${encodeURIComponent(ok)}` : ""}`);

export async function createSessionAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    const r = await createSession(db, c.userId, c.companyId, { displayName: text(fd, "displayName", 100), senderIdentity: text(fd, "senderIdentity", 120), confirmAuthorized: fd.get("confirmAuthorized") === "on" });
    revalidatePath("/whatsapp");
    return { saved: "Conexão criada. Aguarde o QR Code aparecer no cartão e leia com o WhatsApp do aparelho.", sessionId: r.sessionId };
  } catch (e) { return { error: known(e) }; }
}
export async function startSessionAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await startSession(db, c.userId, c.companyId, text(fd, "id", 40)); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp"); back(err, "iniciada");
}
export async function pauseSessionAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await setPaused(db, c.userId, c.companyId, text(fd, "id", 40), true); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp"); back(err, "pausada");
}
export async function resumeSessionAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await setPaused(db, c.userId, c.companyId, text(fd, "id", 40), false); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp"); back(err, "liberada");
}
export async function disconnectSessionAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await disconnectSession(db, c.userId, c.companyId, text(fd, "id", 40), fd.get("confirm") === "on"); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp"); back(err, "desconectada");
}

export async function saveAuthorizationAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    await saveAuthorization(db, c.userId, c.companyId, { reference: text(fd, "reference", 300), phones: text(fd, "phones", 1000), dailyLimit: text(fd, "dailyLimit", 5) });
  } catch (e) { return { error: known(e) }; }
  revalidatePath("/whatsapp/teste");
  redirect("/whatsapp/teste?ok=autorizacao"); // o formulário some depois de salvar: a confirmação vem na página nova
}
export async function settleStaleAction() {
  try { const c = await ctx(); await settleStaleSends(db, c.userId, c.companyId); } catch (e) { known(e); }
  revalidatePath("/whatsapp/teste"); redirect("/whatsapp/teste?ok=reservas");
}
export async function revokeAuthorizationAction() {
  try { const c = await ctx(); await revokeAuthorization(db, c.userId, c.companyId); } catch (e) { known(e); }
  revalidatePath("/whatsapp/teste"); redirect("/whatsapp/teste");
}
export async function sendTestAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    await sendTest(db, c.userId, c.companyId, { sessionId: text(fd, "sessionId", 40), phone: text(fd, "phone", 40), confirm: fd.get("confirm") === "on", key: text(fd, "key", 80) });
    revalidatePath("/whatsapp/teste");
    return { saved: "Teste enviado. Confira no aparelho de destino." };
  } catch (e) { revalidatePath("/whatsapp/teste"); return { error: known(e) }; }
}

export async function bindCompanyAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await bindCompany(db, c.userId, c.companyId, text(fd, "id", 40), { targetCompanyId: text(fd, "targetCompanyId", 40), senderIdentity: text(fd, "senderIdentity", 120), confirm: fd.get("confirm") === "on" }); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp"); back(err, "vinculada");
}
export async function unbindCompanyAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await unbindCompany(db, c.userId, c.companyId, text(fd, "id", 40), fd.get("confirm") === "on"); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp"); back(err, "desvinculada");
}
export async function recordConsentAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    await recordConsent(db, c.userId, c.companyId, { phone: text(fd, "phone", 40), decision: text(fd, "decision", 10), scope: text(fd, "scope", 10), evidenceSource: text(fd, "evidenceSource", 20), evidenceRef: text(fd, "evidenceRef", 300), customerId: text(fd, "customerId", 40) || undefined });
  } catch (e) { return { error: known(e) }; }
  revalidatePath("/whatsapp/consentimentos");
  redirect("/whatsapp/consentimentos?ok=registrado");
}

// ---------- W3a: cobrança de cliente por WhatsApp ----------
export async function saveCompanySettingsAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    await saveCompanySettings(db, c.userId, c.companyId, { enable: fd.get("enable") === "1", reference: text(fd, "reference", 300), dailyCap: text(fd, "dailyCap", 5), phrase: text(fd, "phrase", 80) });
  } catch (e) { return { error: known(e) }; }
  revalidatePath("/whatsapp/configuracao");
  redirect("/whatsapp/configuracao?ok=salvo");
}
export async function ensureWhatsappDefaultsAction() {
  let err = "";
  try { const c = await ctx(); await ensureWhatsappDefaults(db, c.userId, c.companyId); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/configuracao"); redirect(`/whatsapp/configuracao${err ? `?erro=${encodeURIComponent(err)}` : "?ok=modelos"}`);
}
export async function queueCustomerAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    await queueCustomerMessage(db, c.userId, c.companyId, { chargeId: text(fd, "chargeId", 40), templateVersionId: text(fd, "templateVersionId", 40), sessionId: text(fd, "sessionId", 40), confirm: fd.get("confirm") === "on", key: text(fd, "key", 80) });
  } catch (e) { return { error: known(e) }; }
  revalidatePath("/whatsapp/historico");
  redirect("/whatsapp/historico?ok=na_fila");
}
const histBack = (err: string, ok = "") => redirect(`/whatsapp/historico${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`);
export async function dispatchOutboxAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await dispatchOutbox(db, c.userId, c.companyId, text(fd, "id", 40)); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/historico"); histBack(err, "enviado");
}
export async function cancelOutboxAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await cancelOutbox(db, c.userId, c.companyId, text(fd, "id", 40)); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/historico"); histBack(err, "cancelado");
}
export async function resolveUnknownAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await resolveUnknown(db, c.userId, c.companyId, text(fd, "id", 40), text(fd, "outcome", 10) as "enviado" | "falhou"); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/historico"); histBack(err, "conferido");
}
export async function disableCompanySendAction() {
  let err = "";
  try { const c = await ctx(); await saveCompanySettings(db, c.userId, c.companyId, { enable: false }); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/configuracao"); redirect(`/whatsapp/configuracao${err ? `?erro=${encodeURIComponent(err)}` : "?ok=salvo"}`);
}
export async function settleStaleOutboxAction() {
  let err = "";
  try { const c = await ctx(); await settleStaleSends(db, c.userId, c.companyId); } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/historico"); histBack(err, "reservas");
}

// ---------- W3b: caixa de entrada e triagem ----------
const inboxBack = (err: string, ok = "") => redirect(`/whatsapp/entrada${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`);
export async function handleInboxAction(fd: FormData) {
  let err = "";
  try {
    const c = await ctx(); const id = text(fd, "id", 40), op = text(fd, "op", 20);
    if (op === "atender") await setHandling(db, c.userId, c.companyId, id, { handling: "em_atendimento" });
    else if (op === "resolver") await setHandling(db, c.userId, c.companyId, id, { handling: "resolvido" });
    else if (op === "contestacao") await markDispute(db, c.userId, c.companyId, id, true);
    else if (op === "limpar_contestacao") await markDispute(db, c.userId, c.companyId, id, false);
    else if (op === "parar_empresa") await optOutFromInbox(db, c.userId, c.companyId, id, "company");
    else if (op === "parar_todas") await optOutFromInbox(db, c.userId, c.companyId, id, "global");
    else throw new Invalid("Ação inválida");
  } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/entrada"); inboxBack(err, "ok");
}
export async function triageAction(fd: FormData) {
  let err = "";
  try {
    const c = await ctx(); const id = text(fd, "id", 40);
    if (text(fd, "op", 10) === "descartar") await discardTriage(db, c.userId, id);
    else await assignTriage(db, c.userId, id, text(fd, "companyId", 40));
  } catch (e) { err = known(e); }
  revalidatePath("/whatsapp/entrada"); inboxBack(err, "ok");
}
