"use server";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { db } from "@/lib/db";
import { headers } from "next/headers";
import { signIn } from "@/auth";
import { hit } from "@/lib/security/rate-limit";
import { Invalid, acceptInvite } from "@/modules/identity/service";

export type AcceptState = { error?: string; name?: string } | undefined;

export async function accept(token: string, _: AcceptState, fd: FormData): Promise<AcceptState> {
  // devolve o nome para repreencher (React 19 limpa o form após a ação); a senha é limpa de propósito
  const keep = { name: String(fd.get("name") ?? "") };
  const email = String(fd.get("email") ?? ""), password = String(fd.get("password") ?? "");
  if (fd.has("confirm") && password !== String(fd.get("confirm") ?? "")) return { ...keep, error: "A confirmação não confere com a senha" };
  const ip = (await headers()).get("x-real-ip") ?? "unknown";
  // limita tentativas por link e por IP (evita adivinhar a senha de conta existente)
  // também por conta (e-mail): trocar de convite/link não zera as tentativas de adivinhar a senha de uma conta existente
  if ((await hit(db, `invite:${token.slice(0, 16)}`, 10, 15 * 60_000)) || (await hit(db, `invite-ip:${ip}`, 30, 15 * 60_000)) || (await hit(db, `invite-acct:${email.trim().toLowerCase().slice(0, 254)}`, 10, 15 * 60_000))) return { ...keep, error: "Muitas tentativas. Aguarde alguns minutos." };
  try {
    await acceptInvite(db, token, email, keep.name, password);
  } catch (e) {
    if (e instanceof Invalid) return { ...keep, error: e.message };
    throw e;
  }
  // primeiro acesso sem etapa extra: já entra com a senha que acabou de criar (ou confirmar)
  try { await signIn("credentials", { email, password, redirectTo: "/" }); }
  catch (e) { if (e instanceof AuthError) redirect("/login"); throw e; }
}
