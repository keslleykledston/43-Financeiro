"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Invalid } from "@/modules/identity/service";
import { completePasswordReset } from "@/modules/identity/recovery";

export type ResetState = { error?: string } | undefined;

export async function resetAction(token: string, _: ResetState, fd: FormData): Promise<ResetState> {
  const password = String(fd.get("password") ?? ""), confirm = String(fd.get("confirm") ?? "");
  if (password !== confirm) return { error: "A confirmação não confere com a nova senha" };
  const ip = (await headers()).get("x-real-ip") ?? "unknown";
  try { await completePasswordReset(db, token, password, ip); }
  catch (e) { if (e instanceof Invalid) return { error: e.message }; throw e; }
  redirect("/login?senha=ok");
}
