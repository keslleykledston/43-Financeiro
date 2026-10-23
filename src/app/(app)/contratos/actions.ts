"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createContract, decideVersion, proposeChange, setStatus, type ContractStatus } from "@/modules/contracts/service";

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
  try { const c = await ctx(); await proposeChange(db, c.userId, c.companyId, contractId, termsInput(fd), String(fd.get("reason") ?? "") || undefined); }
  catch (e) { return { error: msg(e), values: keep(fd) }; }
  revalidatePath(`/contratos/${contractId}`); revalidatePath("/contratos");
  redirect(`/contratos/${contractId}?proposta=1`);
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
