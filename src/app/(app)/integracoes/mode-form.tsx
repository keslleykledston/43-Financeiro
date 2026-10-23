"use client";
import { useActionState } from "react";
import { setModeAction } from "./actions";

export function ModeForm({ mode, canChange }: { mode: "local" | "crm"; canChange: boolean }) {
  const [s, act, pending] = useActionState(setModeAction, undefined);
  const opt = "flex cursor-pointer gap-3 rounded-xl border border-slate-200 p-3 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50";
  return (
    <form action={act} className="space-y-3">
      <fieldset className="space-y-2" disabled={!canChange}>
        <legend className="sr-only">Origem dos clientes</legend>
        <label className={opt}>
          <input type="radio" name="mode" value="local" defaultChecked={mode === "local"} className="mt-1" />
          <span><strong>Local</strong><br /><span className="text-sm text-slate-600">Clientes e fornecedores são cadastrados e importados por CSV nesta plataforma. A sincronização com o CRM fica desligada.</span></span>
        </label>
        <label className={opt}>
          <input type="radio" name="mode" value="crm" defaultChecked={mode === "crm"} className="mt-1" />
          <span><strong>CRM</strong><br /><span className="text-sm text-slate-600">Clientes (e contratos) vêm do CRM, somente leitura. Cadastro manual e CSV de <em>clientes</em> ficam bloqueados. Fornecedores continuam locais.</span></span>
        </label>
      </fieldset>
      <p className="text-xs text-slate-500">Voltar para <em>Local</em> libera a edição dos cadastros já importados. Ao voltar para <em>CRM</em>, o CRM volta a sobrescrever os campos dos cadastros vinculados.</p>
      {s?.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-green-800">Origem dos clientes salva.</p>}
      {canChange ? <button disabled={pending} className="rounded-xl bg-white px-4 py-2.5 text-sm ring-1 ring-slate-300 disabled:opacity-60">Salvar origem dos clientes</button> : <p className="text-sm text-slate-500">Somente a diretoria altera a origem dos clientes.</p>}
    </form>
  );
}
