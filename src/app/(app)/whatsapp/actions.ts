"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createSession, disconnectSession, revokeAuthorization, saveAuthorization, sendTest, setPaused, settleStaleSends, startSession } from "@/modules/whatsapp/service";

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
