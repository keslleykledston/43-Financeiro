"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { setContractCommission } from "@/modules/commissions/service";
import { cancelScheduledVersion, createContract, decideVersion, todayManaus, proposeAndApprove, proposeChange, setStatus, type ContractStatus } from "@/modules/contracts/service";
import { addNote } from "@/modules/notes/service";
import { saveAdjustmentRule, snoozeAlert, unsnoozeAlert } from "@/modules/contracts/adjustment";

export type FormState = { error?: string; values?: Record<string, string> } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const msg = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const keep = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
const termsInput = (fd: FormData) => ({
  description: fd.get("description"), monthlyAmount: fd.get("monthlyAmount"), startAt: fd.get("startAt"), endAt: fd.get("endAt"),
  dueDay: fd.get("dueDay"), invoiceJointRequired: fd.get("invoiceJointRequired") === "on", issueDayOverride: fd.get("issueDayOverride"),
});

export async function createAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try { const c = await ctx(); id = (await createContract(db, c.userId, c.companyId, String(fd.get("customerId") ?? ""), termsInput(fd), String(fd.get("reason") ?? "") || undefined)).id; }
  catch (e) { return { error: msg(e), values: keep(fd) }; }
  revalidatePath("/contratos"); revalidatePath("/faturamento");
  redirect(`/contratos/${id}`);
}

export async function proposeAction(contractId: string, _: FormState, fd: FormData): Promise<FormState> {
  const am = { kind: fd.get("kind"), effectiveOn: fd.get("effectiveOn"), reference: fd.get("reference") };
  const now = fd.get("approveNow") === "on";
  try {
    const c = await ctx(); const reason = String(fd.get("reason") ?? "") || undefined;
    if (now) await proposeAndApprove(db, c.userId, c.companyId, contractId, termsInput(fd), reason, am);
    else await proposeChange(db, c.userId, c.companyId, contractId, termsInput(fd), reason, am);
  }
  catch (e) { return { error: msg(e), values: keep(fd) }; }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos"); revalidatePath("/faturamento"); revalidatePath("/contratos/alertas");
  const future = String(am.effectiveOn ?? "") > todayManaus();
  redirect(`/contratos/${contractId}?${now ? (future ? "agendado=1" : "aprovado=1") : "proposta=1"}`);
}

export async function decideAction(fd: FormData) {
  const contractId = String(fd.get("contractId") ?? "");
  let err = "";
  try { const c = await ctx(); await decideVersion(db, c.userId, c.companyId, String(fd.get("versionId") ?? ""), fd.get("decision") === "aprovar" ? "aprovar" : "rejeitar", String(fd.get("note") ?? "")); }
  catch (e) { err = msg(e); }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos"); revalidatePath("/faturamento");
  redirect(`/contratos/${contractId}${err ? `?erro=${encodeURIComponent(err)}` : ""}`);
}

export async function statusAction(fd: FormData) {
  const contractId = String(fd.get("contractId") ?? ""); const to = String(fd.get("to") ?? "") as Exclude<ContractStatus, "rascunho">;
  let err = "";
  try { const c = await ctx(); await setStatus(db, c.userId, c.companyId, contractId, to); } catch (e) { err = msg(e); }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos"); revalidatePath("/faturamento");
  redirect(`/contratos/${contractId}${err ? `?erro=${encodeURIComponent(err)}` : ""}`);
}

export async function commissionAction(fd: FormData) {
  const contractId = String(fd.get("contractId") ?? "");
  let err = "";
  try { const c = await ctx(); await setContractCommission(db, c.userId, c.companyId, contractId, { partner: String(fd.get("partner") ?? ""), percent: String(fd.get("percent") ?? "") }); } catch (e) { err = msg(e); }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos"); revalidatePath("/comissoes");
  redirect(`/contratos/${contractId}${err ? `?erro=${encodeURIComponent(err)}` : "?comissao=1"}`);
}

export async function noteAction(fd: FormData) {
  const contractId = String(fd.get("contractId") ?? "");
  let err = "";
  try { const c = await ctx(); await addNote(db, c.userId, c.companyId, { contractId }, String(fd.get("body") ?? "")); } catch (e) { err = msg(e); }
  revalidatePath(`/contratos/${contractId}`);
  redirect(`/contratos/${contractId}${err ? `?erro=${encodeURIComponent(err)}` : "?comentario=1"}#comentarios`);
}

/** Desfaz um aditivo agendado (ainda não valeu). */
export async function cancelScheduleAction(fd: FormData) {
  const contractId = String(fd.get("contractId") ?? "");
  let err = "";
  try { const c = await ctx(); await cancelScheduledVersion(db, c.userId, c.companyId, String(fd.get("versionId") ?? ""), String(fd.get("note") ?? "")); }
  catch (e) { err = msg(e); }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos"); revalidatePath("/faturamento");
  redirect(`/contratos/${contractId}${err ? `?erro=${encodeURIComponent(err)}` : ""}`);
}

// E31 — regra de reajuste do contrato e silenciar alertas (um ciclo)
export async function saveRuleAction(fd: FormData) {
  const contractId = String(fd.get("contractId") ?? ""); let err = "";
  try { const c = await ctx(); await saveAdjustmentRule(db, c.userId, c.companyId, contractId, { index: String(fd.get("index") ?? ""), fixedPct: String(fd.get("fixedPct") ?? ""), note: String(fd.get("note") ?? "") }); } catch (e) { err = msg(e); }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos/alertas");
  redirect(`/contratos/${contractId}${err ? `?erro=${encodeURIComponent(err)}` : "?regra=1"}`);
}
export async function snoozeAction(fd: FormData) {
  let err = "";
  const days = String(fd.get("days") ?? "");
  try { const c = await ctx(); await snoozeAlert(db, c.userId, c.companyId, { contractId: String(fd.get("contractId") ?? ""), kind: String(fd.get("kind") ?? ""), dueDate: String(fd.get("dueDate") ?? ""), days: days ? Number(days) : undefined, note: String(fd.get("note") ?? "") }); } catch (e) { err = msg(e); }
  revalidatePath("/contratos/alertas"); revalidatePath("/contratos");
  redirect(`/contratos/alertas${err ? `?erro=${encodeURIComponent(err)}` : ""}`);
}
export async function unsnoozeAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await unsnoozeAlert(db, c.userId, c.companyId, String(fd.get("snoozeId") ?? "")); } catch (e) { err = msg(e); }
  revalidatePath("/contratos/alertas"); revalidatePath("/contratos");
  redirect(`/contratos/alertas${err ? `?erro=${encodeURIComponent(err)}` : ""}`);
}
