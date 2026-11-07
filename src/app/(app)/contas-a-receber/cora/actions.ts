"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { refreshCoraInvoices, setOverdueCollection } from "@/modules/receivables/cora-invoices";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const known = (e: unknown) => { if (e instanceof Invalid || e instanceof Forbidden) return e.message; throw e; };
const FILTERS = new Set(["atrasados", "a_vencer", "pagos", "cancelados", "todos"]);
const back = (filter: string, err = "", ok = "") => { revalidatePath("/contas-a-receber/cora"); redirect(`/contas-a-receber/cora?filtro=${FILTERS.has(filter) ? filter : "atrasados"}${err ? `&erro=${encodeURIComponent(err)}` : ok ? `&ok=${ok}` : ""}`); };

/** Atualiza AGORA a situação dos boletos em aberto (só leitura na Cora; rápido). A importação completa roda sozinha 1x ao dia. */
export async function refreshCoraAction(fd: FormData) {
  let err = "", ok = "";
  try { const c = await ctx(); const r = await refreshCoraInvoices(db, c.userId, c.companyId); ok = `atualizado:${r.updated}:${r.becamePaid}`; } catch (e) { err = known(e); }
  back(String(fd.get("filtro") ?? ""), err, ok);
}
/** Chave por cliente: cobrança automática dos atrasados. `on` = "1" liga, "0" desliga. Só a diretoria. */
export async function overdueSwitchAction(fd: FormData) {
  const on = fd.get("on") === "1"; let err = "";
  try { const c = await ctx(); await setOverdueCollection(db, c.userId, c.companyId, String(fd.get("customerId") ?? ""), on); } catch (e) { err = known(e); }
  back(String(fd.get("filtro") ?? ""), err, on ? "ligado" : "desligado");
}
