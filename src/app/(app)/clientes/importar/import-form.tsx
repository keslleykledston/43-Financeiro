"use client";
import { useActionState, useState } from "react";
import { importAction, previewAction } from "../actions";

const BADGE = { ok: "bg-positive-soft text-positive-foreground", erro: "bg-negative-soft text-negative-foreground", duplicado: "bg-warning-soft text-warning-foreground" } as const;

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
        <textarea id="csv" name="csv" value={text} onChange={(e) => setText(e.target.value)} rows={6} className="w-full rounded-md border border-input p-3 font-mono text-sm" />
        {prev?.error && <p role="alert" className="text-sm text-negative-foreground">{prev.error}</p>}
        <button disabled={previewing || !text} className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground disabled:opacity-60">Revisar (nada é gravado ainda)</button>
      </form>

      {prev?.rows && !done?.imported && done?.imported !== 0 && (
        <section className="space-y-3 rounded-lg border bg-card p-5" aria-label="Prévia da importação">
          <p role="status" className="text-sm"><strong>{prev.summary!.ok}</strong> válidas · <strong>{prev.summary!.duplicado}</strong> duplicadas · <strong>{prev.summary!.erro}</strong> com erro</p>
          <ul className="max-h-80 divide-y divide-border overflow-auto text-sm">
            {prev.rows.map((r) => (
              <li key={r.line} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0"><p className="truncate">linha {r.line}: {r.legalName || "—"}</p>{r.message && <p className="text-muted-foreground">{r.message}</p>}</div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${BADGE[r.status]}`}>{r.status}</span>
              </li>
            ))}
          </ul>
          <form action={confirm}>
            <input type="hidden" name="csv" value={prev.csv} />
            {done?.error && <p role="alert" className="mb-2 text-sm text-negative-foreground">{done.error}</p>}
            <button disabled={importing || prev.summary!.ok === 0} className="rounded-md bg-positive px-5 py-3 font-medium text-background disabled:opacity-60">Confirmar importação de {prev.summary!.ok}</button>
            <p className="mt-2 text-xs text-muted-foreground">Linhas com erro ou duplicadas são ignoradas. Os dados são revalidados no servidor ao confirmar.</p>
          </form>
        </section>
      )}
      {done?.imported !== undefined && (
        <p role="status" className="rounded-md bg-positive-soft p-4 text-sm text-positive-foreground">Importação concluída: {done.imported} cadastro(s) criados, {done.skipped} ignorados.</p>
      )}
    </div>
  );
}
