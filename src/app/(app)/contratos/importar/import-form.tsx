"use client";
import { useActionState, useState } from "react";
import { confirmAction, previewAction } from "./actions";
import { StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { buttonClass } from "@/components/k3g/button";

const TONE: Record<string, StatusTone> = { ok: "positive", novo_cliente: "info", cliente_ausente: "warning", ja_tem_contrato: "neutral", duplicado: "neutral", erro: "negative" };
const LABEL: Record<string, string> = { ok: "pronto", novo_cliente: "cliente novo", cliente_ausente: "cliente ausente", ja_tem_contrato: "já tem contrato", duplicado: "repetido", erro: "erro" };
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function ImportForm() {
  const [prev, preview, previewing] = useActionState(previewAction, undefined);
  const [done, confirm, importing] = useActionState(confirmAction, undefined);
  const [text, setText] = useState("");
  const importable = prev?.summary ? prev.summary.ok + prev.summary.novo_cliente : 0;
  return (
    <div className="space-y-5">
      <form action={preview} className="space-y-3">
        <label htmlFor="file" className="block text-sm font-medium">Arquivo CSV</label>
        <input id="file" type="file" accept=".csv,text/csv" onChange={async (e) => setText((await e.target.files?.[0]?.text()) ?? "")} className="block w-full text-sm" />
        <label htmlFor="csv" className="block text-sm font-medium">ou cole o conteúdo</label>
        <textarea id="csv" name="csv" value={text} onChange={(e) => setText(e.target.value)} rows={6} className="w-full rounded-md border border-input bg-card p-3 font-mono text-sm" />
        {prev?.error && <p role="alert" className="text-sm text-negative-foreground">{prev.error}</p>}
        <button disabled={previewing || !text} className={buttonClass("primary")}>Revisar (nada é gravado ainda)</button>
      </form>

      {prev?.rows && (
        <section className="space-y-3 rounded-lg border bg-card p-5" aria-label="Prévia da importação">
          <p role="status" className="text-sm">
            <strong>{prev.summary!.ok}</strong> prontas · <strong>{prev.summary!.novo_cliente}</strong> com cliente novo · <strong>{prev.summary!.cliente_ausente}</strong> cliente ausente · <strong>{prev.summary!.ja_tem_contrato}</strong> já têm contrato · <strong>{prev.summary!.duplicado}</strong> repetidas · <strong>{prev.summary!.erro}</strong> com erro
          </p>
          <ul className="max-h-96 divide-y divide-border overflow-auto text-sm">
            {prev.rows.map((r) => (
              <li key={r.line} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate">linha {r.line}: {r.name || "—"}{r.amountCents ? ` · ${brl(r.amountCents)}` : ""}{r.dueDay ? ` · dia ${r.dueDay}` : ""}{r.commissionPartner ? ` · comissão ${r.commissionPartner}` : ""}</p>
                  {(r.message || r.warning) && <p className="text-muted-foreground">{r.message ?? r.warning}</p>}
                </div>
                <StatusPill tone={TONE[r.status]}>{LABEL[r.status]}</StatusPill>
              </li>
            ))}
          </ul>
          <form action={confirm}>
            <input type="hidden" name="csv" value={prev.csv} />
            {done?.error && <p role="alert" className="mb-2 text-sm text-negative-foreground">{done.error}</p>}
            <button disabled={importing || importable === 0} className={buttonClass("success")}>Confirmar: criar {importable} contrato(s) em rascunho</button>
            <p className="mt-2 text-xs text-muted-foreground">Linhas com erro, repetidas, sem cliente ou que já têm contrato são ignoradas. Tudo é revalidado no servidor ao confirmar, e nada vigora até outra pessoa aprovar o lote.</p>
          </form>
        </section>
      )}
    </div>
  );
}
