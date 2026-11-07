"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { attachInvoice, removeInvoice } from "@/modules/invoices/service";
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
  try { const c = await ctx(); await approveBatch(db, c.userId, c.companyId, id, String(fd.get("hash") ?? ""), { schedule: fd.get("schedule") === "1" }); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes"); back(id, err, fd.get("schedule") === "1" ? "agendado" : "aprovado");
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

export async function attachInvoiceAction(fd: FormData) {
  const id = uuid(fd.get("id")); let err = "", replaced = false;
  try {
    const c = await ctx();
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new Invalid("Escolha o PDF da nota fiscal");
    if (f.size > 2_097_152) throw new Invalid("O PDF da nota passa de 2 MB");
    replaced = (await attachInvoice(db, c.userId, c.companyId, uuid(fd.get("chargeId")), { number: String(fd.get("number") ?? ""), issuedOn: String(fd.get("issuedOn") ?? ""), verificationCode: String(fd.get("verificationCode") ?? ""), pdf: new Uint8Array(await f.arrayBuffer()) })).replaced;
  } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes"); back(id, err, replaced ? "nota_trocada" : "nota");
}
export async function removeInvoiceAction(fd: FormData) {
  const id = uuid(fd.get("id")); let err = "";
  try { const c = await ctx(); await removeInvoice(db, c.userId, c.companyId, uuid(fd.get("chargeId"))); } catch (e) { err = known(e); }
  revalidatePath("/faturamento/lotes"); back(id, err, "nota_removida");
}
