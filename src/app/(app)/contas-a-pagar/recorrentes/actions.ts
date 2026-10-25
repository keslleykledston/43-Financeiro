"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { createSeries, createTemplate, generateMonth, listTemplates, setSeriesActive, setTemplateActive, updateTemplate } from "@/modules/payables/planning";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
async function run(back: string, fn: (c: { userId: string; companyId: string }) => Promise<string | void>) {
  let err = "", ok = "1";
  try { const r = await fn(await ctx()); if (r) ok = r; } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/contas-a-pagar", "layout");
  redirect(`${back}${back.includes("?") ? "&" : "?"}${err ? `erro=${encodeURIComponent(err)}` : `ok=${encodeURIComponent(ok)}`}`);
}
const R = "/contas-a-pagar/recorrentes";

export const createTemplateAction = async (fd: FormData) => run(R, async (c) => { await createTemplate(db, c.userId, c.companyId, { vendorId: s(fd, "vendorId"), description: s(fd, "description"), amount: s(fd, "amount"), dueDay: s(fd, "dueDay"), categoryId: s(fd, "categoryId"), costCenterId: s(fd, "costCenterId"), startMonth: s(fd, "startMonth"), endMonth: s(fd, "endMonth") }); return "modelo"; });
export const patchTemplateAction = async (fd: FormData) => run(R, async (c) => {
  const cur = (await listTemplates(db, c.userId, c.companyId)).find((t) => t.id === s(fd, "id"));
  if (!cur) throw new Invalid("Modelo não encontrado");
  await updateTemplate(db, c.userId, c.companyId, cur.id, { vendorId: cur.vendorId, description: cur.description, amount: s(fd, "amount"), dueDay: s(fd, "dueDay"), categoryId: cur.categoryId ?? "", costCenterId: cur.costCenterId ?? "", startMonth: cur.startMonth, endMonth: s(fd, "endMonth") });
  return "modelo";
});
export const toggleTemplateAction = async (fd: FormData) => run(R, async (c) => { await setTemplateActive(db, c.userId, c.companyId, s(fd, "id"), s(fd, "active") === "1"); });
export const createSeriesAction = async (fd: FormData) => run(R, async (c) => { await createSeries(db, c.userId, c.companyId, { vendorId: s(fd, "vendorId"), description: s(fd, "description"), installments: s(fd, "installments"), firstDue: s(fd, "firstDue"), amount: s(fd, "amount"), categoryId: s(fd, "categoryId"), costCenterId: s(fd, "costCenterId") }); return "serie"; });
export const toggleSeriesAction = async (fd: FormData) => run(R, async (c) => { await setSeriesActive(db, c.userId, c.companyId, s(fd, "id"), s(fd, "active") === "1"); });
export const generateMonthAction = async (fd: FormData) => {
  const month = s(fd, "month");
  await run(`/contas-a-pagar/calendario?mes=${encodeURIComponent(month)}`, async (c) => { const r = await generateMonth(db, c.userId, c.companyId, month); return `gerado-${r.created}-${r.skipped}`; });
};
