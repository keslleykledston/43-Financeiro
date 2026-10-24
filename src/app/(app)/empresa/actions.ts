"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { updateCompanyProfile } from "@/modules/companies/service";

export type CompanyState = { error?: string; saved?: string } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
export async function saveCompanyAction(_: CompanyState, fd: FormData): Promise<CompanyState> {
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    const r = await updateCompanyProfile(db, c.user.id, c.current.id, {
      name: fd.get("name"), legalName: fd.get("legalName"), cnpj: fd.get("cnpj"), financeEmail: fd.get("financeEmail"), address: fd.get("address"),
    });
    revalidatePath("/", "layout");
    return { saved: r.changed.length ? `Salvo: ${r.changed.join(", ")}.` : "Nada mudou." };
  } catch (e) {
    if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message };
    throw e;
  }
}
