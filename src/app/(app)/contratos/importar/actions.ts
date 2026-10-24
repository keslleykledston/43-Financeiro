"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { decideImport, importContracts, previewContractImport, type PreviewRow } from "@/modules/contracts/import";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const msg = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };

export type PreviewState = { error?: string; csv?: string; rows?: PreviewRow[]; summary?: Record<"ok" | "novo_cliente" | "cliente_ausente" | "ja_tem_contrato" | "duplicado" | "erro", number> } | undefined;
export type ConfirmState = { error?: string } | undefined;

export async function previewAction(_: PreviewState, fd: FormData): Promise<PreviewState> {
  const csv = String(fd.get("csv") ?? "");
  try { const c = await ctx(); return { csv, ...(await previewContractImport(db, c.userId, c.companyId, csv)) }; }
  catch (e) { return { error: msg(e) }; }
}

export async function confirmAction(_: ConfirmState, fd: FormData): Promise<ConfirmState> {
  let id: string;
  try { const c = await ctx(); id = (await importContracts(db, c.userId, c.companyId, String(fd.get("csv") ?? ""))).importId; }
  catch (e) { return { error: msg(e) }; }
  revalidatePath("/contratos"); revalidatePath("/clientes");
  redirect(`/contratos/importar/${id}`);
}

export async function decideImportAction(fd: FormData) {
  const importId = String(fd.get("importId") ?? "");
  let err = "";
  try { const c = await ctx(); await decideImport(db, c.userId, c.companyId, importId, fd.get("decision") === "aprovar" ? "aprovar" : "rejeitar", String(fd.get("note") ?? "")); }
  catch (e) { err = msg(e); }
  revalidatePath(`/contratos/importar/${importId}`); revalidatePath("/contratos"); revalidatePath("/faturamento");
  redirect(`/contratos/importar/${importId}${err ? `?erro=${encodeURIComponent(err)}` : ""}`);
}
