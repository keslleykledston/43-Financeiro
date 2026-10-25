"use server";
import { headers } from "next/headers";
import { after } from "next/server";
import { db } from "@/lib/db";
import { requestPasswordReset } from "@/modules/identity/recovery";

export type ForgotState = { done?: boolean; error?: string } | undefined;

/** Resposta SEMPRE igual (existindo ou não o e-mail). O trabalho roda depois da resposta, para o tempo também não revelar nada. */
export async function forgotAction(_: ForgotState, fd: FormData): Promise<ForgotState> {
  const email = String(fd.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return { error: "Informe um e-mail válido." };
  const ip = (await headers()).get("x-real-ip") ?? "unknown";
  const baseUrl = process.env.AUTH_URL ?? "";
  after(async () => { try { await requestPasswordReset(db, email, ip, baseUrl); } catch (e) { console.error("reset_request_failed", (e as Error).name); } });
  return { done: true };
}
