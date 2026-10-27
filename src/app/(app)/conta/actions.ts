"use server";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { signOut } from "@/auth";
import { Forbidden, Invalid, changePassword, revokeSessions } from "@/modules/identity/service";
import { beginEnroll, confirmEnroll, disableTwoFactor, regenerateRecoveryCodes } from "@/modules/identity/twofactor";
import { revalidatePath } from "next/cache";

export type PasswordState = { error?: string; ok?: boolean } | undefined;

// O usuário vem SEMPRE da sessão validada no servidor, nunca do formulário.
export async function changePasswordAction(_: PasswordState, fd: FormData): Promise<PasswordState> {
  const ctx = await requireContext();
  const current = String(fd.get("current") ?? ""), next = String(fd.get("next") ?? ""), confirm = String(fd.get("confirm") ?? "");
  if (next !== confirm) return { error: "A confirmação não confere com a nova senha" };
  try { await changePassword(db, ctx.user.id, current, next); return { ok: true }; }
  catch (e) { if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message }; throw e; }
}

/** "Sair em todos os dispositivos": sobe a versão da sessão e leva ao login (o usuário vem da sessão, nunca do formulário). */
export async function revokeSessionsAction() {
  const ctx = await requireContext();
  await revokeSessions(db, ctx.user.id);
  await signOut({ redirectTo: "/login" });
}

// E28 — verificação em duas etapas. O usuário vem SEMPRE da sessão; senha/código vêm do formulário e nunca são devolvidos nem registrados.
export type TfState = { error?: string; step?: "scan" | "codes" | "done"; secret?: string; uri?: string; codes?: string[] } | undefined;
const f = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };

export async function beginTwoFactorAction(_: TfState, fd: FormData): Promise<TfState> {
  const ctx = await requireContext();
  try { const r = await beginEnroll(db, ctx.user.id, f(fd, "password")); return { step: "scan", secret: r.grouped, uri: r.uri }; } catch (e) { return { error: known(e) }; }
}
export async function confirmTwoFactorAction(prev: TfState, fd: FormData): Promise<TfState> {
  const ctx = await requireContext();
  try { const r = await confirmEnroll(db, ctx.user.id, f(fd, "code")); revalidatePath("/conta"); return { step: "codes", codes: r.recoveryCodes }; } catch (e) { return { ...prev, error: known(e) }; }
}
export async function disableTwoFactorAction(_: TfState, fd: FormData): Promise<TfState> {
  const ctx = await requireContext();
  try { await disableTwoFactor(db, ctx.user.id, f(fd, "password"), f(fd, "code")); revalidatePath("/conta"); return { step: "done" }; } catch (e) { return { error: known(e) }; }
}
export async function regenerateCodesAction(_: TfState, fd: FormData): Promise<TfState> {
  const ctx = await requireContext();
  try { const r = await regenerateRecoveryCodes(db, ctx.user.id, f(fd, "code")); revalidatePath("/conta"); return { step: "codes", codes: r.recoveryCodes }; } catch (e) { return { error: known(e) }; }
}
