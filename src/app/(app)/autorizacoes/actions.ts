"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { setBoletos, setBoletosCanary, setEmail, setEmailLimit, setRegua, setReguaKinds, setWhatsapp, setWhatsappLimit, type Fn } from "@/modules/authorizations/panel";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const back = (err = "", ok = "") => { revalidatePath("/autorizacoes"); redirect(`/autorizacoes${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`); };

/** Uma ação por chave: `on` = "1" liga, "0" desliga. Os campos extras (limite, réguas) só valem ao ligar/salvar. */
export async function toggleAction(fd: FormData) {
  const fn = String(fd.get("fn") ?? ""), on = fd.get("on") === "1"; let err = "";
  try {
    const c = await ctx();
    if (fn === "boletos") await setBoletos(db, c.userId, c.companyId, on);
    else if (fn === "email") await setEmail(db, c.userId, c.companyId, on, { dailyLimit: fd.get("dailyLimit") ?? undefined });
    else if (fn === "whatsapp") await setWhatsapp(db, c.userId, c.companyId, on, { dailyCap: fd.get("dailyCap") ?? undefined });
    else if (fn === "regua") await setRegua(db, c.userId, c.companyId, on, { kinds: fd.getAll("kinds") });
    else throw new Invalid("Função desconhecida");
  } catch (e) { err = known(e); }
  back(err, `${fn}:${on ? "ligado" : "desligado"}`);
}
/** Salva só o limite diário (e-mail ou WhatsApp) / as réguas, sem desligar nem ligar nada. */
export async function saveLimitAction(fd: FormData) {
  const fn = String(fd.get("fn") ?? ""); let err = "";
  try {
    const c = await ctx();
    if (fn === "email") await setEmailLimit(db, c.userId, c.companyId, fd.get("dailyLimit"));
    else if (fn === "whatsapp") await setWhatsappLimit(db, c.userId, c.companyId, fd.get("dailyCap"));
    else if (fn === "regua") await setReguaKinds(db, c.userId, c.companyId, fd.getAll("kinds"));
    else throw new Invalid("Função desconhecida");
  } catch (e) { err = known(e); }
  back(err, `${fn}:salvo`);
}
export async function canaryAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await setBoletosCanary(db, c.userId, c.companyId, fd.get("canary") === "1"); } catch (e) { err = known(e); }
  back(err, "boletos:salvo");
}
export type { Fn };
