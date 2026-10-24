"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { cancelStatement, closeMonth, markPaid } from "@/modules/commissions/service";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const msg = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const back = (fd: FormData, extra: string) => {
  const q = new URLSearchParams({ parceiro: String(fd.get("partner") ?? ""), mes: String(fd.get("month") ?? "") });
  redirect(`/comissoes?${q.toString()}${extra}`);
};

export async function closeAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await closeMonth(db, c.userId, c.companyId, String(fd.get("partner") ?? ""), String(fd.get("month") ?? "")); } catch (e) { err = msg(e); }
  revalidatePath("/comissoes");
  back(fd, err ? `&erro=${encodeURIComponent(err)}` : "&ok=fechado");
}

export async function paidAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await markPaid(db, c.userId, c.companyId, String(fd.get("statementId") ?? ""), { paidOn: String(fd.get("paidOn") ?? ""), note: String(fd.get("note") ?? "") }); } catch (e) { err = msg(e); }
  revalidatePath("/comissoes");
  back(fd, err ? `&erro=${encodeURIComponent(err)}` : "&ok=pago");
}

export async function cancelAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await cancelStatement(db, c.userId, c.companyId, String(fd.get("statementId") ?? ""), String(fd.get("reason") ?? "")); } catch (e) { err = msg(e); }
  revalidatePath("/comissoes");
  back(fd, err ? `&erro=${encodeURIComponent(err)}` : "&ok=cancelado");
}
