"use client";
import { useActionState } from "react";
import { saveCompanyAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

type P = { name: string; legalName: string | null; cnpj: string | null; financeEmail: string | null };
const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

export function CompanyForm({ profile }: { profile: P }) {
  const [s, act, pending] = useActionState(saveCompanyAction, undefined);
  return (
    <form action={act} className="space-y-4">
      <div><L id="name">Nome (aparece no sistema)</L><input id="name" name="name" required maxLength={120} defaultValue={profile.name} className={inputClass} /></div>
      <div><L id="legalName">Razão social</L><input id="legalName" name="legalName" maxLength={200} defaultValue={profile.legalName ?? ""} className={inputClass} /></div>
      <div><L id="cnpj">CNPJ</L><input id="cnpj" name="cnpj" maxLength={30} defaultValue={profile.cnpj ?? ""} placeholder="00.000.000/0000-00" className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Conferimos os dígitos verificadores. Cada CNPJ só pode estar em uma empresa. Trocar o CNPJ não muda a conta da Cora: confira se a conta bate com o CNPJ.</p></div>
      <div><L id="financeEmail">E-mail do financeiro</L><input id="financeEmail" name="financeEmail" type="email" maxLength={200} defaultValue={profile.financeEmail ?? ""} className={inputClass} /></div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Salvar"}</button>
    </form>
  );
}
