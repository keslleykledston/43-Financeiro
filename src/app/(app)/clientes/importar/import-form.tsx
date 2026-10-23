"use client";
import { useActionState, useState } from "react";
import { importAction, previewAction } from "../actions";

const BADGE = { ok: "bg-green-100 text-green-800", erro: "bg-red-100 text-red-800", duplicado: "bg-amber-100 text-amber-800" } as const;

export function ImportForm() {
  const [prev, preview, previewing] = useActionState(previewAction, undefined);
  const [done, confirm, importing] = useActionState(importAction, undefined);
  const [text, setText] = useState("");
  return (
    <div className="space-y-5">
      <form action={preview} className="space-y-3">
        <label htmlFor="file" className="block text-sm font-medium">Arquivo CSV</label>
        <input id="file" type="file" accept=".csv,text/csv" onChange={async (e) => setText((await e.target.files?.[0]?.text()) ?? "")} className="block w-full text-sm" />
        <label htmlFor="csv" className="block text-sm font-medium">ou cole o conteúdo</label>
        <textarea id="csv" name="csv" value={text} onChange={(e) => setText(e.target.value)} rows={6} className="w-full rounded-xl border border-slate-300 p-3 font-mono text-sm" />
        {prev?.error && <p role="alert" className="text-sm text-red-700">{prev.error}</p>}
        <button disabled={previewing || !text} className="rounded-xl bg-blue-600 px-5 py-3 font-medium text-white disabled:opacity-60">Revisar (nada é gravado ainda)</button>
      </form>

      {prev?.rows && !done?.imported && done?.imported !== 0 && (
        <section className="space-y-3 rounded-2xl bg-white p-5 shadow-sm" aria-label="Prévia da importação">
          <p role="status" className="text-sm"><strong>{prev.summary!.ok}</strong> válidas · <strong>{prev.summary!.duplicado}</strong> duplicadas · <strong>{prev.summary!.erro}</strong> com erro</p>
          <ul className="max-h-80 divide-y divide-slate-100 overflow-auto text-sm">
            {prev.rows.map((r) => (
              <li key={r.line} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0"><p className="truncate">linha {r.line}: {r.legalName || "—"}</p>{r.message && <p className="text-slate-500">{r.message}</p>}</div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${BADGE[r.status]}`}>{r.status}</span>
              </li>
            ))}
          </ul>
          <form action={confirm}>
            <input type="hidden" name="csv" value={prev.csv} />
            {done?.error && <p role="alert" className="mb-2 text-sm text-red-700">{done.error}</p>}
            <button disabled={importing || prev.summary!.ok === 0} className="rounded-xl bg-green-600 px-5 py-3 font-medium text-white disabled:opacity-60">Confirmar importação de {prev.summary!.ok}</button>
            <p className="mt-2 text-xs text-slate-500">Linhas com erro ou duplicadas são ignoradas. Os dados são revalidados no servidor ao confirmar.</p>
          </form>
        </section>
      )}
      {done?.imported !== undefined && (
        <p role="status" className="rounded-xl bg-green-50 p-4 text-sm text-green-900">Importação concluída: {done.imported} cadastro(s) criados, {done.skipped} ignorados.</p>
      )}
    </div>
  );
}
