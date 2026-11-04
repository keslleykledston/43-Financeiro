"use client";
import { useActionState } from "react";
import { saveAddressAction, savePrefsAction, saveTextsAction, type ExtrasState } from "./extras-actions";
import { buttonClass, inputClass } from "@/components/k3g/button";

type A = { cep: string | null; street: string | null; streetNumber: string | null; complement: string | null; district: string | null; cityName: string | null; cityIbge: string | null; uf: string | null };
const L = ({ id, children, hint }: { id: string; children: React.ReactNode; hint?: string }) => <div className="mb-1"><label htmlFor={id} className="block text-sm font-medium">{children}</label>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>;
const Msg = ({ s }: { s: ExtrasState }) => <>{s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}{s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}</>;

export function AddressForm({ id, a }: { id: string; a: A }) {
  const [s, act, pending] = useActionState(saveAddressAction.bind(null, id), undefined);
  const f = (k: keyof A, label: string, o: { hint?: string; max?: number; ph?: string; full?: boolean } = {}) => (
    <div className={o.full ? "sm:col-span-2" : ""}><L id={`addr-${k}`} hint={o.hint}>{label}</L><input id={`addr-${k}`} name={k} defaultValue={a[k] ?? ""} maxLength={o.max ?? 80} placeholder={o.ph} className={inputClass} /></div>
  );
  return (
    <form action={act} className="space-y-3">
      <p className="text-sm text-muted-foreground">Endereço do cliente (usado como tomador na nota fiscal). Fica só aqui: a sincronização com o CRM não altera.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {f("cep", "CEP", { max: 12, ph: "69000-000" })}{f("uf", "UF", { max: 2, ph: "AM" })}
        {f("street", "Logradouro", { max: 160, full: true })}{f("streetNumber", "Número", { max: 20 })}{f("complement", "Complemento")}
        {f("district", "Bairro")}{f("cityName", "Município")}{f("cityIbge", "Código IBGE do município", { hint: "7 dígitos (Manaus: 1302603)", max: 12 })}
      </div>
      <Msg s={s} />
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Salvar endereço"}</button>
    </form>
  );
}

export function TextsForm({ id, nfText, boletoText }: { id: string; nfText: string | null; boletoText: string | null }) {
  const [s, act, pending] = useActionState(saveTextsAction.bind(null, id), undefined);
  const box = "w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm";
  return (
    <form action={act} className="space-y-3">
      <p className="text-sm text-muted-foreground">Textos próprios deste cliente. Em branco, vale o padrão (descrição do contrato na nota; nenhuma instrução no boleto). Campos que você pode usar: <code>{"{{cliente}} {{empresa}} {{valor}} {{vencimento}} {{competencia}} {{descricao}} {{emissao}}"}</code>. Só texto simples.</p>
      <div><L id="nfText" hint="Descrição do serviço que vai na nota fiscal (NFS-e). Ex.: Serviços de monitoramento de redes — competência {{competencia}}.">Texto da nota fiscal</L>
        <textarea id="nfText" name="nfText" rows={4} maxLength={1000} defaultValue={nfText ?? ""} className={box} /></div>
      <div><L id="boletoText" hint="Instruções que saem no boleto. Ex.: Não receber após 10 dias do vencimento. Referente a {{descricao}}.">Texto do boleto</L>
        <textarea id="boletoText" name="boletoText" rows={3} maxLength={400} defaultValue={boletoText ?? ""} className={box} /></div>
      <Msg s={s} />
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Salvar textos"}</button>
    </form>
  );
}

/** Nome aparente + o que o cliente recebe. Fica só aqui (o CRM não o tem), então vale também para cliente vindo do CRM. */
export function PrefsForm({ id, alias, issuesBoleto, issuesInvoice, shownByRule }: { id: string; alias: string | null; issuesBoleto: boolean; issuesInvoice: boolean; shownByRule: string }) {
  const [s, act, pending] = useActionState(savePrefsAction.bind(null, id), undefined);
  const check = "mt-0.5 size-4 accent-primary";
  return (
    <form action={act} className="space-y-3">
      <div><L id="alias" hint={`Como este cliente é conhecido no dia a dia. Aparece no lugar do nome em todas as telas e na busca. Em branco, vale «${shownByRule}». Boleto e nota continuam saindo com a razão social.`}>Nome aparente</L>
        <input id="alias" name="alias" defaultValue={alias ?? ""} maxLength={120} className={inputClass} /></div>
      <fieldset className="space-y-2 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">O que este cliente recebe</legend>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="issuesBoleto" defaultChecked={issuesBoleto} className={check} /><span><strong>Emite boleto</strong><span className="block text-xs text-muted-foreground">Desmarcado, o cliente fica de fora da emissão de boletos (ex.: paga por outro meio).</span></span></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="issuesInvoice" defaultChecked={issuesInvoice} className={check} /><span><strong>Emite nota fiscal</strong><span className="block text-xs text-muted-foreground">Marcado, a nota fiscal é esperada: o lote mostra onde anexar o PDF e avisa quando falta.</span></span></label>
      </fieldset>
      <Msg s={s} />
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Salvando…" : "Salvar nome e emissão"}</button>
    </form>
  );
}
