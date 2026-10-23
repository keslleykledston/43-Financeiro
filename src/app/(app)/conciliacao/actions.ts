"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { MAX_BYTES } from "@/modules/banking/parsers";
import { allocate, cancelImport, confirmImport, createAccount, markTransaction, previewImport, undoAllocation, undoImport, unmarkTransaction } from "@/modules/banking/service";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const go = (path: string, err = "", ok = "") => redirect(`${path}${err ? `?erro=${encodeURIComponent(err)}` : ok ? `?ok=${encodeURIComponent(ok)}` : ""}`);
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function createAccountAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await createAccount(db, c.userId, c.companyId, { name: s(fd, "name"), bank: s(fd, "bank"), last4: s(fd, "last4"), openingBalance: s(fd, "openingBalance"), openingDate: s(fd, "openingDate") }); } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); go("/conciliacao", err, "conta");
}

export async function previewAction(fd: FormData) {
  const accountId = s(fd, "accountId"); let batchId = "", err = "";
  try {
    const c = await ctx();
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new Invalid("Escolha o arquivo do extrato");
    if (f.size > MAX_BYTES) throw new Invalid("O arquivo passa de 2 MB");
    batchId = (await previewImport(db, c.userId, c.companyId, accountId, f.name, new Uint8Array(await f.arrayBuffer()))).batchId;
  } catch (e) { err = known(e); }
  if (batchId) redirect(`/conciliacao/importacoes/${batchId}`);
  go(`/conciliacao/contas/${accountId}/importar`, err);
}

export async function confirmImportAction(fd: FormData) {
  const id = s(fd, "id"); let err = "", ok = "";
  try { const c = await ctx(); const r = await confirmImport(db, c.userId, c.companyId, id); ok = `importado:${r.imported}:${r.duplicates}`; } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); go(`/conciliacao/importacoes/${id}`, err, ok);
}
export async function cancelImportAction(fd: FormData) {
  const id = s(fd, "id"), account = s(fd, "accountId"); let err = "";
  try { const c = await ctx(); await cancelImport(db, c.userId, c.companyId, id); } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); if (err) go(`/conciliacao/importacoes/${id}`, err); redirect(`/conciliacao/contas/${account}`);
}
export async function undoImportAction(fd: FormData) {
  const id = s(fd, "id"); let err = "";
  try { const c = await ctx(); await undoImport(db, c.userId, c.companyId, id, s(fd, "reason")); } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); go(`/conciliacao/importacoes/${id}`, err, "desfeita");
}

export async function allocateAction(fd: FormData) {
  const tx = s(fd, "txId"), back = s(fd, "back") === "lista" ? `/conciliacao/contas/${s(fd, "accountId")}` : `/conciliacao/transacoes/${tx}`; let err = "", ok = "vinculado";
  try { const c = await ctx(); const r = await allocate(db, c.userId, c.companyId, tx, s(fd, "chargeId"), s(fd, "amount"), s(fd, "requestKey")); if (r.settled) ok = "quitada"; } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); revalidatePath("/contas-a-receber"); go(back, err, ok);
}
export async function undoAllocationAction(fd: FormData) {
  const tx = s(fd, "txId"); let err = "";
  try { const c = await ctx(); await undoAllocation(db, c.userId, c.companyId, s(fd, "allocationId"), s(fd, "reason")); } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); revalidatePath("/contas-a-receber"); go(`/conciliacao/transacoes/${tx}`, err, "desfeito");
}
export async function markAction(fd: FormData) {
  const tx = s(fd, "txId"); let err = "";
  try { const c = await ctx(); await markTransaction(db, c.userId, c.companyId, tx, s(fd, "kind"), s(fd, "note")); } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); go(`/conciliacao/transacoes/${tx}`, err, "classificada");
}
export async function unmarkAction(fd: FormData) {
  const tx = s(fd, "txId"); let err = "";
  try { const c = await ctx(); await unmarkTransaction(db, c.userId, c.companyId, tx); } catch (e) { err = known(e); }
  revalidatePath("/conciliacao"); go(`/conciliacao/transacoes/${tx}`, err, "liberada");
}
