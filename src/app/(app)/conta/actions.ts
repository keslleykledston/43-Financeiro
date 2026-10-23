"use server";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid, changePassword } from "@/modules/identity/service";

export type PasswordState = { error?: string; ok?: boolean } | undefined;

// O usuário vem SEMPRE da sessão validada no servidor, nunca do formulário.
export async function changePasswordAction(_: PasswordState, fd: FormData): Promise<PasswordState> {
  const ctx = await requireContext();
  const current = String(fd.get("current") ?? ""), next = String(fd.get("next") ?? ""), confirm = String(fd.get("confirm") ?? "");
  if (next !== confirm) return { error: "A confirmação não confere com a nova senha" };
  try { await changePassword(db, ctx.user.id, current, next); return { ok: true }; }
  catch (e) { if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message }; throw e; }
}
