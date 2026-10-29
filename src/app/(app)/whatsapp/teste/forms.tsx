"use client";
import { useActionState, useEffect, useState } from "react";
import { saveAuthorizationAction, sendTestAction } from "../actions";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";

const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

export function AuthorizationForm() {
  const [s, act, pending] = useActionState(saveAuthorizationAction, undefined);
  return (
    <form action={act} className="space-y-3">
      <div><L id="wa-ref">Referência da autorização escrita</L><input id="wa-ref" name="reference" required minLength={5} maxLength={200} placeholder="Ex.: e-mail da diretoria de 29/10/2026" className={inputClass} /></div>
      <div><L id="wa-phones">Números que podem receber o teste (um por linha)</L>
        <textarea id="wa-phones" name="phones" required rows={3} placeholder={"92 99999-0000\n92 98888-1111"} className="w-full rounded-md border border-input bg-card px-3 py-2.5 font-mono text-xs" />
        <p className="mt-1 text-xs text-muted-foreground">Só números de quem sabe que vai receber (até 10). O sistema guarda os números e mostra só mascarados.</p></div>
      <div><L id="wa-limit">Limite diário de testes (1 a 10)</L><input id="wa-limit" name="dailyLimit" type="number" min={1} max={10} defaultValue={5} required className={`${inputClass} max-w-[8rem]`} /></div>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className={buttonClass("outline")}>Registrar autorização</button>
    </form>
  );
}

export function SendForm({ sessions, sessionId, phone, canSend }: { sessions: { id: string; name: string }[]; sessionId: string; phone: string; canSend: boolean }) {
  const [s, act, pending] = useActionState(sendTestAction, undefined);
  // Uma chave por tentativa: reenviar o MESMO formulário (duplo clique, recarga) nunca manda de novo. Depois de cada resposta, vem uma chave nova.
  // (getRandomValues funciona também fora de HTTPS; randomUUID não). Começa vazia e nasce no navegador: sem diferença entre o HTML do servidor e o do cliente.
  const [key, setKey] = useState("");
  useEffect(() => { setKey(newKey()); }, [s]);
  return (
    <form action={act} className="space-y-3">
      <input type="hidden" name="key" value={key} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div><L id="wa-session">Conexão</L><select id="wa-session" name="sessionId" defaultValue={sessionId} required className={`${selectClass} w-full`}>
          <option value="">Escolha…</option>{sessions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div><L id="wa-phone">Número de destino</L><input id="wa-phone" name="phone" defaultValue={phone} required maxLength={40} inputMode="tel" placeholder="92 99999-0000" className={inputClass} /></div>
      </div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" required className="mt-0.5 size-4 rounded border-input accent-primary" /><span>Confirmo que este número é meu (ou de quem autorizou) e que vou receber uma mensagem de teste.</span></label>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending || !canSend || !key} className={buttonClass("primary")}>{pending ? "Enviando…" : "Enviar mensagem de teste"}</button>
      {!canSend && <p className="text-xs text-muted-foreground">O botão libera quando toda a lista de verificação estiver verde (clique em «Conferir»).</p>}
    </form>
  );
}
