"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { saveCategory, saveCostCenter, savePartner, setCategoryActive, setCostCenterActive, setPartnerActive } from "@/modules/expenses/catalog";

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
async function ctx() { const c = await requireContext(); if (!c.current) throw new Forbidden(); return { userId: c.user.id, companyId: c.current.id }; }
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");
async function run(fn: (c: { userId: string; companyId: string }) => Promise<unknown>) {
  let err = "";
  try { await fn(await ctx()); } catch (e) { if (e instanceof Invalid || e instanceof Forbidden) err = e.message; else throw e; }
  revalidatePath("/despesas-cadastros"); revalidatePath("/socios"); revalidatePath("/contas-a-pagar");
  redirect(`/despesas-cadastros${err ? `?erro=${encodeURIComponent(err)}` : "?ok=1"}`);
}

export const saveCategoryAction = async (fd: FormData) => run((c) => saveCategory(db, c.userId, c.companyId, { id: s(fd, "id") || undefined, name: s(fd, "name"), grp: s(fd, "grp"), kind: s(fd, "kind") }));
export const toggleCategoryAction = async (fd: FormData) => run((c) => setCategoryActive(db, c.userId, c.companyId, s(fd, "id"), s(fd, "active") === "1"));
export const saveCenterAction = async (fd: FormData) => run((c) => saveCostCenter(db, c.userId, c.companyId, { id: s(fd, "id") || undefined, name: s(fd, "name") }));
export const toggleCenterAction = async (fd: FormData) => run((c) => setCostCenterActive(db, c.userId, c.companyId, s(fd, "id"), s(fd, "active") === "1"));
export const savePartnerAction = async (fd: FormData) => run((c) => savePartner(db, c.userId, c.companyId, { id: s(fd, "id") || undefined, name: s(fd, "name") }));
export const togglePartnerAction = async (fd: FormData) => run((c) => setPartnerActive(db, c.userId, c.companyId, s(fd, "id"), s(fd, "active") === "1"));
