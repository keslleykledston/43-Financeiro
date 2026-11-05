"use client";
import { useActionState } from "react";
import { importCertificateAction, verifyCertificateAction, type CertState } from "./actions";

const box = "w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm";

/** Escrita apenas: o arquivo e a senha só vão ao servidor (HTTPS), são conferidos, cifrados e a senha é descartada. Nada volta para a tela. */
export function CertificateForm({ replace }: { replace: boolean }) {
  const [s, act, pending] = useActionState(importCertificateAction, undefined);
  return (
    <form action={act} autoComplete="off" className="space-y-3">
      <div><label htmlFor="cert-pfx" className="mb-1 block text-sm font-medium">{replace ? "Novo certificado (.pfx / .p12)" : "Certificado A1 (.pfx / .p12)"}</label>
        <input id="cert-pfx" name="pfx" type="file" accept=".pfx,.p12,application/x-pkcs12" required className="block w-full text-sm" /></div>
      <div><label htmlFor="cert-password" className="mb-1 block text-sm font-medium">Senha do certificado</label>
        <input id="cert-password" name="pfxPassword" type="password" autoComplete="new-password" required maxLength={200} className={box} placeholder="a senha definida na certificadora" /></div>
      <p className="text-xs text-muted-foreground">O arquivo é conferido (senha, validade e se é <strong>o CNPJ desta empresa</strong>), guardado <strong>cifrado</strong> e a <strong>senha é descartada</strong>. Nada disto volta para a tela. {replace && "Importar outro substitui e apaga o anterior."}</p>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">{pending ? "Conferindo…" : replace ? "Substituir certificado" : "Importar certificado"}</button>
    </form>
  );
}

export function CertificateVerify() {
  const [s, act, pending] = useActionState<CertState, FormData>(verifyCertificateAction, undefined);
  return (
    <form action={act} className="inline-flex flex-wrap items-center gap-2">
      <button disabled={pending} className="rounded-md px-2.5 py-1 text-xs ring-1 ring-border disabled:opacity-60">{pending ? "Conferindo…" : "Conferir integridade"}</button>
      {s?.message && <span role="status" className={`text-xs ${s.ok ? "text-positive-foreground" : "text-negative-foreground"}`}>{s.message}</span>}
    </form>
  );
}
