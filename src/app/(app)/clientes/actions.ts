"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { addNote } from "@/modules/notes/service";
import { addContact, createParty, importParties, previewImport, removeContact, setArchived, updateParty, type ImportRow } from "@/modules/crm/service";

export type FormState = { error?: string; values?: Record<string, string> } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() {
  const c = await requireContext();
  if (!c.current) throw new Forbidden();
  return { userId: c.user.id, companyId: c.current.id };
}
const msg = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const partyInput = (fd: FormData) => ({
  kind: String(fd.get("kind") ?? ""), legalName: String(fd.get("legalName") ?? ""),
  tradeName: String(fd.get("tradeName") ?? ""), document: String(fd.get("document") ?? ""),
  status: String(fd.get("status") ?? "") || undefined,
});
const keep = (fd: FormData) => Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;

export async function createAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try { const c = await ctx(); id = (await createParty(db, c.userId, c.companyId, partyInput(fd))).id; }
  catch (e) { return { error: msg(e), values: keep(fd) }; }
  revalidatePath("/clientes");
  redirect(`/clientes/${id}`);
}

export async function updateAction(id: string, _: FormState, fd: FormData): Promise<FormState> {
  try { const c = await ctx(); await updateParty(db, c.userId, c.companyId, id, partyInput(fd)); }
  catch (e) { return { error: msg(e), values: keep(fd) }; }
  revalidatePath(`/clientes/${id}`);
  redirect(`/clientes/${id}?salvo=1`);
}

export async function archiveAction(fd: FormData) {
  const id = String(fd.get("id") ?? ""), archived = fd.get("archived") === "1";
  try { const c = await ctx(); await setArchived(db, c.userId, c.companyId, id, archived); } catch (e) { msg(e); }
  revalidatePath("/clientes");
  redirect(archived ? "/clientes" : `/clientes/${id}`);
}

export async function addContactAction(partyId: string, _: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await ctx();
    await addContact(db, c.userId, c.companyId, partyId, {
      name: String(fd.get("name") ?? ""), email: String(fd.get("email") ?? ""), phone: String(fd.get("phone") ?? ""), isFinancial: fd.get("isFinancial") === "on",
    });
  } catch (e) { return { error: msg(e), values: keep(fd) }; }
  revalidatePath(`/clientes/${partyId}`);
  return undefined;
}

export async function removeContactAction(fd: FormData) {
  try { const c = await ctx(); await removeContact(db, c.userId, c.companyId, String(fd.get("contactId") ?? "")); } catch (e) { msg(e); }
  revalidatePath(`/clientes/${String(fd.get("partyId") ?? "")}`);
}

export type PreviewState = { error?: string; csv?: string; rows?: ImportRow[]; summary?: { ok: number; erro: number; duplicado: number } } | undefined;
export type ImportState = { error?: string; imported?: number; skipped?: number } | undefined;

export async function previewAction(_: PreviewState, fd: FormData): Promise<PreviewState> {
  const csv = String(fd.get("csv") ?? "");
  try { const c = await ctx(); return { csv, ...(await previewImport(db, c.userId, c.companyId, csv)) }; }
  catch (e) { return { error: msg(e) }; }
}

export async function importAction(_: ImportState, fd: FormData): Promise<ImportState> {
  try {
    const c = await ctx();
    const r = await importParties(db, c.userId, c.companyId, String(fd.get("csv") ?? ""));
    revalidatePath("/clientes");
    return r;
  } catch (e) { return { error: msg(e) }; }
}

export async function noteAction(fd: FormData) {
  const partyId = String(fd.get("partyId") ?? "");
  let err = "";
  try { const c = await ctx(); await addNote(db, c.userId, c.companyId, { customerId: partyId }, String(fd.get("body") ?? "")); } catch (e) { err = msg(e); }
  revalidatePath(`/clientes/${partyId}`);
  redirect(`/clientes/${partyId}${err ? `?erro=${encodeURIComponent(err)}` : ""}#comentarios`);
}
