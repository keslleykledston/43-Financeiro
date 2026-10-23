"use client";
import { useActionState } from "react";
import { setModeAction } from "./actions";

export function ModeForm({ mode, canChange }: { mode: "local" | "crm"; canChange: boolean }) {
  const [s, act, pending] = useActionState(setModeAction, undefined);
  const opt = "flex cursor-pointer gap-3 rounded-md border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft";
  return (
    <form action={act} className="space-y-3">
      <fieldset className="space-y-2" disabled={!canChange}>
        <legend className="sr-only">Origem dos clientes</legend>
        <label className={opt}>
          <input type="radio" name="mode" value="local" defaultChecked={mode === "local"} className="mt-1" />
          <span><strong>Local</strong><br /><span className="text-sm text-muted-foreground">Clientes e fornecedores são cadastrados e importados por CSV nesta plataforma. A sincronização com o CRM fica desligada.</span></span>
        </label>
        <label className={opt}>
          <input type="radio" name="mode" value="crm" defaultChecked={mode === "crm"} className="mt-1" />
          <span><strong>CRM</strong><br /><span className="text-sm text-muted-foreground">Clientes (e contratos) vêm do CRM, somente leitura. Cadastro manual e CSV de <em>clientes</em> ficam bloqueados. Fornecedores continuam locais.</span></span>
        </label>
      </fieldset>
      <p className="text-xs text-muted-foreground">Voltar para <em>Local</em> libera a edição dos cadastros já importados. Ao voltar para <em>CRM</em>, o CRM volta a sobrescrever os campos dos cadastros vinculados.</p>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">Origem dos clientes salva.</p>}
      {canChange ? <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">Salvar origem dos clientes</button> : <p className="text-sm text-muted-foreground">Somente a diretoria altera a origem dos clientes.</p>}
    </form>
  );
}
