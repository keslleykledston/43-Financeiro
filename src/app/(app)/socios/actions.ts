"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createEntry, reverseEntry } from "@/modules/expenses/ledger";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export type EntryState = { error?: string; ok?: boolean } | undefined;

export async function createEntryAction(_: EntryState, fd: FormData): Promise<EntryState> {
  try {
    const c = await ctx();
    await createEntry(db, c.userId, c.companyId, { partnerId: s(fd, "partnerId"), kind: s(fd, "kind"), amount: s(fd, "amount"), occurredOn: s(fd, "occurredOn"), categoryId: s(fd, "categoryId"), description: s(fd, "description"), requestKey: s(fd, "requestKey") });
  } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message }; throw e; }
  revalidatePath("/socios");
  return { ok: true };
}

export async function reverseEntryAction(fd: FormData) {
  let err = "";
  try { const c = await ctx(); await reverseEntry(db, c.userId, c.companyId, s(fd, "id"), s(fd, "reason")); } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/socios");
  redirect(`/socios${err ? `?erro=${encodeURIComponent(err)}` : "?ok=estornado"}`);
}
