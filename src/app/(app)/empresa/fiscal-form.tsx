"use client";
import { useActionState } from "react";
import { saveFiscalAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";
import type { FiscalValues } from "@/modules/companies/fiscal";

const L = ({ id, children, hint }: { id: string; children: React.ReactNode; hint?: string }) => <div className="mb-1"><label htmlFor={id} className="block text-sm font-medium">{children}</label>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>;
const pct = (bps: number | null) => (bps === null ? "" : String(bps / 100).replace(".", ","));

export function FiscalForm({ v }: { v: FiscalValues }) {
  const [s, act, pending] = useActionState(saveFiscalAction, undefined);
  const f = (id: keyof FiscalValues | "issRate", label: string, def: string | null, opts: { hint?: string; ph?: string; max?: number; full?: boolean; type?: string } = {}) => (
    <div className={opts.full ? "sm:col-span-2" : ""}><L id={id} hint={opts.hint}>{label}</L><input id={id} name={id} type={opts.type ?? "text"} maxLength={opts.max ?? 160} defaultValue={def ?? ""} placeholder={opts.ph} className={inputClass} /></div>
  );
  return (
    <form action={act} className="space-y-6">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Contabilidade (contador ou escritório)</legend>
        {f("accountantName", "Nome do contador / escritório", v.accountantName, { full: true })}
        {f("accountantDocument", "CPF ou CNPJ", v.accountantDocument, { max: 30 })}
        {f("accountantCrc", "CRC (registro profissional)", v.accountantCrc, { max: 30, ph: "CRC/AM 000000/O" })}
        {f("accountantContact", "Pessoa de contato", v.accountantContact, { max: 120 })}
        {f("accountantPhone", "Telefone / WhatsApp", v.accountantPhone, { max: 30 })}
        {f("accountantEmail", "E-mail", v.accountantEmail, { max: 200, type: "email", full: true })}
        <div className="sm:col-span-2"><L id="accountantNotes" hint="Ex.: prazo de fechamento do mês, quem emite as notas, horário de atendimento.">Observações</L><textarea id="accountantNotes" name="accountantNotes" rows={2} maxLength={500} defaultValue={v.accountantNotes ?? ""} className="w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm" /></div>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-1 font-semibold">Dados fiscais para a nota (NFS-e)</legend>
        <p className="text-xs text-muted-foreground sm:col-span-2">Preencha com o contador. Guardar estes dados <strong>não emite nota nem fala com a prefeitura</strong>: eles só deixam a empresa pronta para quando a emissão for liberada.</p>
        <div><L id="taxRegime">Regime tributário</L><select id="taxRegime" name="taxRegime" defaultValue={v.taxRegime ?? ""} className={inputClass}><option value="">Selecione…</option><option value="mei">MEI</option><option value="simples">Simples Nacional</option><option value="presumido">Lucro presumido</option><option value="real">Lucro real</option></select></div>
        {f("municipalRegistration", "Inscrição municipal", v.municipalRegistration, { max: 30 })}
        {f("cnae", "CNAE principal", v.cnae, { hint: "7 dígitos", max: 12, ph: "6190601" })}
        {f("serviceCode", "Código do serviço (LC 116)", v.serviceCode, { hint: "Ex.: 1.07", max: 10 })}
        {f("issRate", "Alíquota do ISS (%)", pct(v.issRateBps), { hint: "De 0 a 5, ex.: 2 ou 2,5", max: 10 })}
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="issWithheld" defaultChecked={v.issWithheld} /> ISS retido pelo tomador (padrão)</label>
        {f("street", "Logradouro", v.street, { full: true })}
        {f("streetNumber", "Número", v.streetNumber, { max: 20 })}
        {f("complement", "Complemento", v.complement, { max: 80 })}
        {f("district", "Bairro", v.district, { max: 80 })}
        {f("cep", "CEP", v.cep, { max: 12, ph: "69000-000" })}
        {f("cityName", "Município", v.cityName, { max: 80 })}
        {f("cityIbge", "Código IBGE do município", v.cityIbge, { hint: "7 dígitos (Manaus: 1302603)", max: 12 })}
        {f("uf", "UF", v.uf, { max: 2, ph: "AM" })}
        {f("phone", "Telefone da empresa", v.phone, { max: 30 })}
      </fieldset>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Salvar contabilidade e dados fiscais"}</button>
    </form>
  );
}
