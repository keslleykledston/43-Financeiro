"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { getCrmAdapter } from "@/modules/integrations/crm/factory";
import { applySync, previewSync, resolveConflict, saveConnection } from "@/modules/integrations/crm/sync";

type Sample = Awaited<ReturnType<typeof previewSync>>;
export type PreviewState = { error?: string; planHash?: string; stats?: Sample["stats"]; sample?: Sample["sample"] } | undefined;
export type ApplyState = { error?: string; stats?: Sample["stats"] } | undefined;
export type ConnState = { error?: string; saved?: boolean } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor.
async function ctx() {
  const c = await requireContext();
  if (!c.current) throw new Forbidden();
  return { userId: c.user.id, companyId: c.current.id };
}
const msg = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };

export async function saveConnectionAction(_: ConnState, fd: FormData): Promise<ConnState> {
  try {
    const c = await ctx();
    await saveConnection(db, c.userId, c.companyId, { enabled: fd.get("enabled") === "on", companyRef: String(fd.get("companyRef") ?? "") });
  } catch (e) { return { error: msg(e) }; }
  revalidatePath("/integracoes");
  return { saved: true };
}

export async function previewAction(): Promise<PreviewState> {
  try { const c = await ctx(); return await previewSync(db, getCrmAdapter(), c.userId, c.companyId); }
  catch (e) { return { error: msg(e) }; }
}

export async function applyAction(_: ApplyState, fd: FormData): Promise<ApplyState> {
  try {
    const c = await ctx();
    const stats = await applySync(db, getCrmAdapter(), c.userId, c.companyId, String(fd.get("expectedHash") ?? ""));
    revalidatePath("/integracoes"); revalidatePath("/clientes");
    return { stats };
  } catch (e) { return { error: msg(e) }; }
}

export async function resolveAction(fd: FormData) {
  const action = fd.get("action") === "link" ? "link" : "ignore";
  try { const c = await ctx(); await resolveConflict(db, c.userId, c.companyId, String(fd.get("conflictId") ?? ""), action); } catch (e) { msg(e); }
  revalidatePath("/integracoes");
}
