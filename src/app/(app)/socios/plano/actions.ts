"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { saveProfitSettings, setPartnerPlan } from "@/modules/expenses/plan";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
async function run(fn: (c: { userId: string; companyId: string }) => Promise<void>) {
  let err = "";
  try { await fn(await ctx()); } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/socios/plano");
  redirect(`/socios/plano${err ? `?erro=${encodeURIComponent(err)}` : "?ok=1"}`);
}

export const saveSettingsAction = async (fd: FormData) => run((c) => saveProfitSettings(db, c.userId, c.companyId, { delinquency: s(fd, "delinquency"), unplanned: s(fd, "unplanned"), reserveMonths: s(fd, "reserveMonths"), retention: s(fd, "retention"), cashNow: s(fd, "cashNow"), cashAsOf: s(fd, "cashAsOf") }));
export const savePartnerPlanAction = async (fd: FormData) => run((c) => setPartnerPlan(db, c.userId, c.companyId, s(fd, "partnerId"), s(fd, "amount")));
