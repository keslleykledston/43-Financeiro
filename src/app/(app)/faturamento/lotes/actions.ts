"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { approveBatch, cancelBatch, generateBatch, reopenBatch } from "@/modules/billing/batches";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const mesOk = (m: string) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : "");
const uuid = (v: FormDataEntryValue | null) => String(v ?? "");

export async function generateAction(fd: FormData) {
  const mes = mesOk(String(fd.get("mes") ?? "")); let id = "", err = "";
  try { const c = await ctx(); id = (await generateBatch(db, c.userId, c.companyId, String(fd.get("issueDate") ?? ""))).batchId; } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes");
  redirect(id ? `/faturamento/lotes/${id}` : `/faturamento/lotes?mes=${mes}&erro=${encodeURIComponent(err)}`);
}

function back(id: string, err = "", ok = "") { redirect(`/faturamento/lotes/${id}${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`); }

export async function approveAction(fd: FormData) {
  const id = uuid(fd.get("id")); let err = "";
  try { const c = await ctx(); await approveBatch(db, c.userId, c.companyId, id, String(fd.get("hash") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes"); back(id, err, "aprovado");
}
export async function reopenAction(fd: FormData) {
  const id = uuid(fd.get("id")); let err = "";
  try { const c = await ctx(); await reopenBatch(db, c.userId, c.companyId, id, String(fd.get("reason") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes"); back(id, err, "reaberto");
}
export async function refreshAction(fd: FormData) {
  const id = uuid(fd.get("id")); let err = "";
  try { const c = await ctx(); await generateBatch(db, c.userId, c.companyId, String(fd.get("issueDate") ?? "")); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes"); back(id, err, "atualizado");
}
export async function cancelAction(fd: FormData) {
  const id = uuid(fd.get("id")); let err = "";
  try { const c = await ctx(); await cancelBatch(db, c.userId, c.companyId, id); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes");
  if (err) back(id, err); else redirect("/faturamento/lotes");
}
