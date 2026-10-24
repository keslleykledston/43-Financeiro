"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { removeDocumentFix, removeLegacyImport, saveDocumentFix } from "@/modules/history/service";

export async function removeImportAction(fd: FormData) {
  let err = "";
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    if (fd.get("confirm") !== "on") throw new Invalid("Marque a confirmação para desfazer a importação");
    await removeLegacyImport(db, c.user.id, c.current.id, String(fd.get("importId") ?? ""));
  } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/historico");
  redirect(`/historico${err ? `?erro=${encodeURIComponent(err)}` : "?removido=1"}`);
}

export type FixState = { error?: string; saved?: string } | undefined;

export async function saveFixAction(_: FixState, fd: FormData): Promise<FixState> {
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    const r = await saveDocumentFix(db, c.user.id, c.current.id, { name: String(fd.get("name") ?? "").slice(0, 300), document: String(fd.get("document") ?? "").slice(0, 40), note: String(fd.get("note") ?? "").slice(0, 300), expected: String(fd.get("expected") ?? "").slice(0, 40) });
    revalidatePath("/historico");
    return { saved: `Corrigido para ${r.formatted}.` };
  } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message }; throw e; }
}

export async function removeFixAction(fd: FormData) {
  let err = "";
  try { const c = await requireContext(); if (!c.current) throw new Forbidden(); await removeDocumentFix(db, c.user.id, c.current.id, String(fd.get("fixId") ?? "")); }
  catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/historico");
  redirect(`/historico${err ? `?erro=${encodeURIComponent(err)}` : ""}#corrigir`);
}
