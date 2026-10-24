"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { ADDRESS_KEYS, TEXT_KEYS, updateCustomerExtras } from "@/modules/crm/extras";

export type ExtrasState = { error?: string; saved?: string } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor.
async function save(id: string, fd: FormData, keys: readonly string[]): Promise<ExtrasState> {
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    const input = Object.fromEntries(keys.map((k) => [k, String(fd.get(k) ?? "").slice(0, 1200)]));
    const r = await updateCustomerExtras(db, c.user.id, c.current.id, id, input);
    revalidatePath(`/clientes/${id}`);
    return { saved: r.changed.length ? `Salvo: ${r.changed.join(", ")}.` : "Nada mudou." };
  } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message }; throw e; }
}
export async function saveAddressAction(id: string, _: ExtrasState, fd: FormData): Promise<ExtrasState> { return save(id, fd, ADDRESS_KEYS); }
export async function saveTextsAction(id: string, _: ExtrasState, fd: FormData): Promise<ExtrasState> { return save(id, fd, TEXT_KEYS); }
