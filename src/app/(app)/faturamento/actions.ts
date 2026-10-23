"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { addHoliday, removeHoliday } from "@/modules/billing/service";

async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const back = (mes: string, err = "") => redirect(`/faturamento?mes=${/^\d{4}-\d{2}$/.test(mes) ? mes : ""}${err ? `&erro=${encodeURIComponent(err)}` : ""}#feriados`);

export async function addHolidayAction(fd: FormData) {
  const mes = String(fd.get("mes") ?? ""); let err = "";
  try { const c = await ctx(); await addHoliday(db, c.userId, c.companyId, { day: fd.get("day"), name: fd.get("name") }); }
  catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/faturamento"); back(mes, err);
}
export async function removeHolidayAction(fd: FormData) {
  const mes = String(fd.get("mes") ?? ""); let err = "";
  try { const c = await ctx(); await removeHoliday(db, c.userId, c.companyId, String(fd.get("id") ?? "")); }
  catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/faturamento"); back(mes, err);
}
