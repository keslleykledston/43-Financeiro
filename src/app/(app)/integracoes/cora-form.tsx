"use client";
import { useActionState } from "react";
import { saveCoraAction } from "./actions";

const box = "w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm";

/** Escrita apenas: depois de salvar nada volta para a tela, e o navegador não guarda estes campos. */
export function CoraForm() {
  const [s, act, pending] = useActionState(saveCoraAction, undefined);
  return (
    <form action={act} autoComplete="off" className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div><label htmlFor="cora-environment" className="mb-1 block text-sm font-medium">Ambiente</label>
          <select id="cora-environment" name="environment" defaultValue="homologacao" className={box}><option value="homologacao">Homologação (testes)</option><option value="producao">Produção</option></select></div>
        <div><label htmlFor="cora-label" className="mb-1 block text-sm font-medium">Apelido da conta (opcional)</label>
          <input id="cora-label" name="label" maxLength={60} className={box} placeholder="ex.: Conta Cora K3G Solutions" /></div>
      </div>
      <div><label htmlFor="cora-clientId" className="mb-1 block text-sm font-medium">Client ID</label>
        <input id="cora-clientId" name="clientId" type="password" autoComplete="off" required maxLength={200} className={box} placeholder="o client-id da integração direta" /></div>
      <div><label htmlFor="cora-certificate" className="mb-1 block text-sm font-medium">Certificado (.pem / .crt)</label>
        <textarea id="cora-certificate" name="certificate" rows={4} autoComplete="off" spellCheck={false} className={`${box} font-mono text-xs`} placeholder="-----BEGIN CERTIFICATE-----" />
        <label htmlFor="cora-certificateFile" className="mt-1 block text-xs text-muted-foreground">ou envie o arquivo</label><input id="cora-certificateFile" name="certificateFile" type="file" accept=".pem,.crt,.cer,.txt" className="text-xs" /></div>
      <div><label htmlFor="cora-privateKey" className="mb-1 block text-sm font-medium">Chave privada (.pem / .key)</label>
        <textarea id="cora-privateKey" name="privateKey" rows={4} autoComplete="off" spellCheck={false} className={`${box} font-mono text-xs`} placeholder="-----BEGIN PRIVATE KEY-----" />
        <label htmlFor="cora-privateKeyFile" className="mt-1 block text-xs text-muted-foreground">ou envie o arquivo</label><input id="cora-privateKeyFile" name="privateKeyFile" type="file" accept=".pem,.key,.txt" className="text-xs" /></div>
      <p className="text-xs text-muted-foreground">Os dados são conferidos, guardados <strong>cifrados</strong> no servidor e <strong>nunca</strong> aparecem de volta nesta tela. Para trocar, salve de novo (substitui). Se algo estiver errado, revise e envie outra vez: por segurança os campos são limpos.</p>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">Guardar credenciais</button>
    </form>
  );
}
