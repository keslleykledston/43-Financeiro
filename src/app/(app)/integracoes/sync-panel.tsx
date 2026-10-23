"use client";
import { useActionState } from "react";
import { applyAction, previewAction } from "./actions";

const REASON: Record<string, string> = { duplicate_document: "já existe cadastro local com este documento", document_collision: "documento colide com outro cadastro ativo", ambiguous_company: "empresa de origem ambígua" };

export function SyncPanel() {
  const [pv, preview, previewing] = useActionState(previewAction, undefined);
  const [done, apply, applying] = useActionState(applyAction, undefined);
  const st = pv?.stats;
  return (
    <div className="space-y-4">
      <form action={preview}>
        <button disabled={previewing} className="rounded-xl bg-blue-600 px-5 py-3 font-medium text-white disabled:opacity-60">{previewing ? "Consultando o CRM…" : "Revisar sincronização"}</button>
        <p className="mt-1 text-xs text-slate-500">Consulta o CRM e mostra o que mudaria. Nada é gravado ainda.</p>
      </form>
      {pv?.error && <p role="alert" className="text-sm text-red-700">{pv.error}</p>}
      {st && !done?.stats && (
        <section aria-label="Prévia da sincronização" className="space-y-3 rounded-2xl bg-white p-5 shadow-sm">
          <p role="status" className="text-sm">
            <strong>{st.create}</strong> novos · <strong>{st.update}</strong> alterados · <strong>{st.archive}</strong> a arquivar · <strong>{st.restore}</strong> a restaurar · <strong>{st.conflict}</strong> conflitos · {st.unchanged} sem mudança · {st.invalid} inválidos · {st.skipped} ignorados
          </p>
          <ul className="max-h-72 space-y-1 overflow-auto text-sm">
            {pv.sample!.create.map((x, i) => <li key={`c${i}`}>＋ {x.legalName} <span className="text-slate-500">{x.document}</span></li>)}
            {pv.sample!.update.map((x, i) => <li key={`u${i}`}>✎ {x.legalName}</li>)}
            {pv.sample!.archive.map((x, i) => <li key={`a${i}`}>⌫ {x.legalName} <span className="text-slate-500">(inativo no CRM)</span></li>)}
            {pv.sample!.restore.map((x, i) => <li key={`r${i}`}>↺ {x.legalName}</li>)}
            {pv.sample!.conflicts.map((x, i) => <li key={`k${i}`} className="text-amber-800">⚠ {x.legalName} — {REASON[x.reason] ?? x.reason}</li>)}
          </ul>
          <form action={apply}>
            <input type="hidden" name="expectedHash" value={pv.planHash} />
            {done?.error && <p role="alert" className="mb-2 text-sm text-red-700">{done.error}</p>}
            <button disabled={applying} className="rounded-xl bg-green-600 px-5 py-3 font-medium text-white disabled:opacity-60">Confirmar e aplicar</button>
            <p className="mt-2 text-xs text-slate-500">Conflitos não são aplicados: ficam na fila para você decidir. O servidor refaz a consulta ao confirmar.</p>
          </form>
        </section>
      )}
      {done?.stats && <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-green-900">Sincronização concluída: {done.stats.create} criados, {done.stats.update} alterados, {done.stats.archive} arquivados, {done.stats.restore} restaurados, {done.stats.conflict} conflitos para revisão.</p>}
    </div>
  );
}
