"use client";
import { useActionState } from "react";
import { recordConsentAction } from "../actions";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";

const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

export function ConsentForm({ customers, sources, canGlobal }: { customers: { id: string; name: string }[]; sources: { value: string; label: string }[]; canGlobal: boolean }) {
  const [s, act, pending] = useActionState(recordConsentAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div><L id="cs-phone">Número do contato</L><input id="cs-phone" name="phone" required maxLength={40} inputMode="tel" placeholder="92 99999-0000" className={inputClass} /></div>
        <div><L id="cs-customer">Cliente (opcional)</L><select id="cs-customer" name="customerId" defaultValue="" className={`${selectClass} w-full`}><option value="">Sem vínculo</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><L id="cs-decision">O que o contato decidiu</L><select id="cs-decision" name="decision" required defaultValue="" className={`${selectClass} w-full`}><option value="" disabled>Escolha…</option><option value="opt_in">Consentiu em receber avisos de cobrança</option><option value="opt_out">Pediu para NÃO receber</option></select></div>
        <div><L id="cs-scope">Vale para</L><select id="cs-scope" name="scope" defaultValue="company" className={`${selectClass} w-full`}><option value="company">Só esta empresa</option>{canGlobal && <option value="global">Todas as empresas (só vale para «pediu para não receber»)</option>}</select></div>
        <div><L id="cs-source">De onde vem a prova</L><select id="cs-source" name="evidenceSource" required defaultValue="" className={`${selectClass} w-full`}><option value="" disabled>Escolha…</option>{sources.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select></div>
        <div><L id="cs-ref">Onde está a prova</L><input id="cs-ref" name="evidenceRef" required minLength={3} maxLength={200} placeholder="Ex.: e-mail de 28/10, contrato 123, anotação do atendimento" className={inputClass} /></div>
      </div>
      <p className="text-xs text-muted-foreground">Não escreva dado pessoal no campo da prova (e-mail, telefone, CPF/CNPJ são recusados): só uma referência de onde achá-la. O registro é permanente (para mudar, registre um novo). Desfazer um pedido de parar de <strong>todas</strong> as empresas exige prova por escrito, formulário ou iniciada pelo cliente.</p>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      <button disabled={pending} className={buttonClass("primary")}>{pending ? "Registrando…" : "Registrar"}</button>
    </form>
  );
}
