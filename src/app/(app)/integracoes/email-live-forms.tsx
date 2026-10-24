"use client";
import { useActionState } from "react";
import { authorizeEmailLiveAction, testEmailAction } from "./actions";

const box = "w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm";
const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

export function AuthorizeForm({ ownDomain }: { ownDomain: string }) {
  const [s, act, pending] = useActionState(authorizeEmailLiveAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <div><L id="live-ref">Referência da autorização escrita</L><input id="live-ref" name="reference" required minLength={5} maxLength={200} placeholder="Ex.: e-mail da diretoria de 25/10/2026, pasta Autorizações" className={box} /></div>
      <div><L id="live-allowed">Quem pode receber (um por linha ou separado por vírgula)</L>
        <textarea id="live-allowed" name="allowed" required rows={3} placeholder={`@${ownDomain}\nfulano@outraempresa.com.br`} className={`${box} font-mono text-xs`} />
        <p className="mt-1 text-xs text-muted-foreground">Endereços exatos, ou <code>@{ownDomain}</code> para todo o domínio do remetente. Outros domínios, só endereço por endereço (até 20).</p></div>
      <div><L id="live-limit">Limite diário de mensagens (1 a 200)</L><input id="live-limit" name="dailyLimit" type="number" min={1} max={200} defaultValue={10} required className={`${box} max-w-[8rem]`} /></div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">Registrar autorização</button>
    </form>
  );
}

export function TestForm() {
  const [s, act, pending] = useActionState(testEmailAction, undefined);
  return (
    <form action={act} className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1"><L id="test-to">Enviar e-mail de teste para</L><input id="test-to" name="to" type="email" required maxLength={200} placeholder="alguem@seudominio.com.br" className={box} /></div>
        <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">{pending ? "Enviando…" : "Enviar teste"}</button>
      </div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
    </form>
  );
}
