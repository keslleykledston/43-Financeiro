"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { addAdjustment, removeAdjustment } from "@/modules/billing/adjustments";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const compOk = (c: string) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(c) ? c : "");
const back = (comp: string, err = "", ok = "", anchor = "") => redirect(`/faturamento/ajustes?mes=${compOk(comp)}${err ? `&erro=${encodeURIComponent(err)}` : ok ? `&ok=${ok}` : ""}${anchor}`);

export async function addAdjustmentAction(fd: FormData) {
  const comp = s(fd, "competence"); let err = "";
  try { const c = await ctx(); await addAdjustment(db, c.userId, c.companyId, { contractId: s(fd, "contractId"), competence: comp, kind: s(fd, "kind"), description: s(fd, "description"), amount: s(fd, "amount") }); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/ajustes"); revalidatePath("/faturamento/lotes");
  back(comp, err, "lancado", `#c-${s(fd, "contractId")}`);
}
export async function removeAdjustmentAction(fd: FormData) {
  const comp = s(fd, "competence"); let err = "";
  try { const c = await ctx(); await removeAdjustment(db, c.userId, c.companyId, s(fd, "id")); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/ajustes"); revalidatePath("/faturamento/lotes");
  back(comp, err, "removido", `#c-${s(fd, "contractId")}`);
}
