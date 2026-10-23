"use server";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { headers } from "next/headers";
import { hit } from "@/lib/security/rate-limit";
import { Invalid, acceptInvite } from "@/modules/identity/service";

export type AcceptState = { error?: string; email?: string; name?: string } | undefined;

export async function accept(token: string, _: AcceptState, fd: FormData): Promise<AcceptState> {
  // devolve e-mail/nome para repreencher (React 19 limpa o form após a ação); a senha é limpa de propósito
  const keep = { email: String(fd.get("email") ?? ""), name: String(fd.get("name") ?? "") };
  const ip = (await headers()).get("x-real-ip") ?? "unknown";
  // limita tentativas por link e por IP (evita adivinhar a senha de conta existente)
  if ((await hit(db, `invite:${token.slice(0, 16)}`, 10, 15 * 60_000)) || (await hit(db, `invite-ip:${ip}`, 30, 15 * 60_000))) return { ...keep, error: "Muitas tentativas. Aguarde alguns minutos." };
  try {
    await acceptInvite(db, token, String(fd.get("email") ?? ""), String(fd.get("name") ?? ""), String(fd.get("password") ?? ""));
  } catch (e) {
    if (e instanceof Invalid) return { ...keep, error: e.message };
    throw e;
  }
  redirect("/login");
}
