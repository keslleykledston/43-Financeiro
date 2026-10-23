"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { registerPayment, reversePayment } from "@/modules/receivables/service";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const back = (id: string, err = "", ok = "") => redirect(`/contas-a-receber/${id}${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`);

export async function payAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "", ok = "pago";
  try {
    const c = await ctx();
    const r = await registerPayment(db, c.userId, c.companyId, id, { amount: String(fd.get("amount") ?? ""), paidAt: String(fd.get("paidAt") ?? ""), method: String(fd.get("method") ?? ""), note: String(fd.get("note") ?? ""), requestKey: String(fd.get("requestKey") ?? "") });
    if (r.settled) ok = "quitada";
  } catch (e) { err = known(e); }
  revalidatePath("/contas-a-receber"); revalidatePath("/mensagens");
  back(id, err, ok);
}

export async function reverseAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "";
  try { const c = await ctx(); await reversePayment(db, c.userId, c.companyId, String(fd.get("paymentId") ?? ""), String(fd.get("reason") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/contas-a-receber");
  back(id, err, "estornado");
}
