"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { approvePayable, cancelPayable, createPayable, registerPayablePayment, rejectPayable, reversePayablePayment, savePayablesSettings, submitPayable, updatePayable } from "@/modules/payables/service";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
const back = (id: string, err = "", ok = "") => redirect(`/contas-a-pagar/${id}${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`);

export type FormState = { error?: string; duplicate?: boolean } | undefined;

export async function savePayableAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = s(fd, "id"); let newId = "";
  const input = { vendorId: s(fd, "vendorId"), description: s(fd, "description"), documentNumber: s(fd, "documentNumber"), amount: s(fd, "amount"), dueDate: s(fd, "dueDate"), category: s(fd, "category"), categoryId: s(fd, "categoryId"), costCenterId: s(fd, "costCenterId"), competence: s(fd, "competence"), force: fd.get("force") === "on" };
  try {
    const c = await ctx();
    if (id) await updatePayable(db, c.userId, c.companyId, id, input); else newId = await createPayable(db, c.userId, c.companyId, input);
  } catch (e) {
    const m = known(e);
    return m.startsWith("POSSIVEL_DUPLICIDADE") ? { error: m.replace("POSSIVEL_DUPLICIDADE: ", ""), duplicate: true } : { error: m };
  }
  revalidatePath("/contas-a-pagar");
  redirect(`/contas-a-pagar/${id || newId}?ok=${id ? "salvo" : "criado"}`);
}

export async function submitAction(fd: FormData) { const id = s(fd, "id"); let err = ""; try { const c = await ctx(); await submitPayable(db, c.userId, c.companyId, id); } catch (e) { err = known(e); } revalidatePath("/contas-a-pagar"); back(id, err, "enviado"); }
export async function approveAction(fd: FormData) { const id = s(fd, "id"); let err = ""; try { const c = await ctx(); await approvePayable(db, c.userId, c.companyId, id, s(fd, "note")); } catch (e) { err = known(e); } revalidatePath("/contas-a-pagar"); revalidatePath("/"); back(id, err, "aprovado"); }
export async function rejectAction(fd: FormData) { const id = s(fd, "id"); let err = ""; try { const c = await ctx(); await rejectPayable(db, c.userId, c.companyId, id, s(fd, "reason")); } catch (e) { err = known(e); } revalidatePath("/contas-a-pagar"); back(id, err, "rejeitado"); }
export async function cancelAction(fd: FormData) { const id = s(fd, "id"); let err = ""; try { const c = await ctx(); await cancelPayable(db, c.userId, c.companyId, id, s(fd, "reason")); } catch (e) { err = known(e); } revalidatePath("/contas-a-pagar"); revalidatePath("/"); back(id, err, "cancelado"); }
export async function payAction(fd: FormData) {
  const id = s(fd, "id"); let err = "", ok = "pago";
  try { const c = await ctx(); const r = await registerPayablePayment(db, c.userId, c.companyId, id, { amount: s(fd, "amount"), paidAt: s(fd, "paidAt"), method: s(fd, "method"), reference: s(fd, "reference"), note: s(fd, "note"), requestKey: s(fd, "requestKey") }); if (r.settled) ok = "quitada"; } catch (e) { err = known(e); }
  revalidatePath("/contas-a-pagar"); revalidatePath("/"); back(id, err, ok);
}
export async function reverseAction(fd: FormData) { const id = s(fd, "id"); let err = ""; try { const c = await ctx(); await reversePayablePayment(db, c.userId, c.companyId, s(fd, "paymentId"), s(fd, "reason")); } catch (e) { err = known(e); } revalidatePath("/contas-a-pagar"); revalidatePath("/"); back(id, err, "estornado"); }
export async function saveSettingsAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await savePayablesSettings(db, c.userId, c.companyId, { managerLimit: s(fd, "managerLimit"), directorSelfApproval: fd.get("directorSelfApproval") === "on" }); } catch (e) { err = known(e); }
  revalidatePath("/contas-a-pagar"); redirect(`/contas-a-pagar${err ? `?erro=${encodeURIComponent(err)}` : "?ok=config"}`);
}
