"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { registerPayment, reversePayment } from "@/modules/receivables/service";
import { cancelBoleto, recheckCancellation } from "@/modules/issuance/cancel";
import { decideCancelRequest, requestBoletoCancel, withdrawCancelRequest } from "@/modules/issuance/cancel-request";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const back = (id: string, err = "", ok = "") => redirect(`/contas-a-receber/${id}${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${ok}` : ""}`);

export async function payAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "", ok = "pago";
  try {
    const c = await ctx();
    const r = await registerPayment(db, c.userId, c.companyId, id, { amount: String(fd.get("amount") ?? ""), paidAt: String(fd.get("paidAt") ?? ""), method: String(fd.get("method") ?? ""), note: String(fd.get("note") ?? ""), requestKey: String(fd.get("requestKey") ?? ""), interest: String(fd.get("interest") ?? ""), discount: String(fd.get("discount") ?? "") });
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

export async function cancelBoletoAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "", ok = "boleto_cancelado";
  try {
    const c = await ctx();
    const r = await cancelBoleto(db, c.userId, c.companyId, { chargeId: id, reason: String(fd.get("reason") ?? ""), confirm: fd.get("confirm") === "on", confirmLive: fd.get("confirmLive") === "on" });
    if (r.status === "falhou") err = "O provedor não cancelou o boleto. Veja o motivo no histórico do boleto";
    else if (r.status === "desconhecido") { ok = "boleto_sem_resposta"; }
  } catch (e) { err = known(e); }
  revalidatePath("/contas-a-receber"); revalidatePath("/mensagens"); revalidatePath("/faturamento/emissoes");
  back(id, err, ok);
}

export async function recheckBoletoAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "", ok = "boleto_cancelado";
  try {
    const c = await ctx();
    const r = await recheckCancellation(db, c.userId, c.companyId, String(fd.get("cancellationId") ?? ""));
    if (r.status === "falhou") err = "O provedor não cancelou o boleto. Veja o motivo no histórico do boleto";
    else if (r.status === "desconhecido") ok = "boleto_sem_resposta";
  } catch (e) { err = known(e); }
  revalidatePath("/contas-a-receber"); revalidatePath("/mensagens"); revalidatePath("/faturamento/emissoes");
  back(id, err, ok);
}

// E30 — pedido de cancelamento (gerente/assistente) e decisão da diretoria
export async function requestCancelAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "";
  try { const c = await ctx(); await requestBoletoCancel(db, c.userId, c.companyId, { chargeId: id, reason: String(fd.get("reason") ?? "") }); } catch (e) { err = known(e); }
  revalidatePath(`/contas-a-receber/${id}`); revalidatePath("/");
  back(id, err, "pedido_enviado");
}
export async function withdrawCancelRequestAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "";
  try { const c = await ctx(); await withdrawCancelRequest(db, c.userId, c.companyId, String(fd.get("requestId") ?? "")); } catch (e) { err = known(e); }
  revalidatePath(`/contas-a-receber/${id}`); revalidatePath("/");
  back(id, err, "pedido_retirado");
}
export async function decideCancelRequestAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""); let err = "", ok = "boleto_cancelado";
  try {
    const c = await ctx(); const approve = fd.get("decision") === "aprovar";
    if (approve && fd.get("confirm") !== "on") throw new Invalid("Confirme o cancelamento marcando a caixa de confirmação");
    const r = await decideCancelRequest(db, c.userId, c.companyId, String(fd.get("requestId") ?? ""), approve ? "aprovar" : "recusar", String(fd.get("note") ?? ""), undefined, new Date(), { confirmLive: fd.get("confirmLive") === "on" });
    if (r.status === "recusado") ok = "pedido_recusado";
    else if (r.result === "falhou") err = "O provedor não cancelou o boleto. Veja o motivo no histórico do boleto";
    else if (r.result === "desconhecido") ok = "boleto_sem_resposta";
  } catch (e) { err = known(e); }
  revalidatePath("/contas-a-receber"); revalidatePath("/mensagens"); revalidatePath("/faturamento/emissoes"); revalidatePath("/");
  back(id, err, ok);
}
