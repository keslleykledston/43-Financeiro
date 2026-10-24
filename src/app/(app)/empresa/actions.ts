"use server";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { Forbidden, Invalid } from "@/modules/identity/service";
import { updateCompanyProfile } from "@/modules/companies/service";
import { updateFiscalProfile } from "@/modules/companies/fiscal";

export type CompanyState = { error?: string; saved?: string } | undefined;

// A empresa vem SEMPRE do contexto validado no servidor, nunca do formulário.
export async function saveCompanyAction(_: CompanyState, fd: FormData): Promise<CompanyState> {
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    const r = await updateCompanyProfile(db, c.user.id, c.current.id, {
      name: fd.get("name"), legalName: fd.get("legalName"), cnpj: fd.get("cnpj"), financeEmail: fd.get("financeEmail")
    });
    revalidatePath("/", "layout");
    return { saved: r.changed.length ? `Salvo: ${r.changed.join(", ")}.` : "Nada mudou." };
  } catch (e) {
    if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message };
    throw e;
  }
}

const FISCAL_FIELDS = ["accountantName", "accountantDocument", "accountantCrc", "accountantContact", "accountantEmail", "accountantPhone", "accountantNotes", "taxRegime", "municipalRegistration", "cnae", "serviceCode", "issRate", "cityName", "cityIbge", "uf", "cep", "street", "streetNumber", "complement", "district", "phone"] as const;

export async function saveFiscalAction(_: CompanyState, fd: FormData): Promise<CompanyState> {
  try {
    const c = await requireContext();
    if (!c.current) throw new Forbidden();
    const input: Record<string, unknown> = Object.fromEntries(FISCAL_FIELDS.map((k) => [k, String(fd.get(k) ?? "").slice(0, 600)]));
    input.issWithheld = fd.get("issWithheld") === "on";
    const r = await updateFiscalProfile(db, c.user.id, c.current.id, input);
    revalidatePath("/empresa"); revalidatePath("/integracoes");
    return { saved: r.changed.length ? `Salvo: ${r.changed.join(", ")}.` : "Nada mudou." };
  } catch (e) {
    if (e instanceof Invalid || e instanceof Forbidden) return { error: e.message };
    throw e;
  }
}
