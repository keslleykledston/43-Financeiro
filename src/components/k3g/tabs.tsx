"use client";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TabDef = { id: string; label: string; content: ReactNode };

/** Abas simples (todas renderizadas no servidor; o navegador só mostra uma). Acessível por teclado (setas) e com `aria-*`. */
export function Tabs({ tabs, initial, label }: { tabs: TabDef[]; initial?: string; label: string }) {
  const [active, setActive] = useState(tabs.some((t) => t.id === initial) ? initial! : tabs[0].id);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setActive(n.id); document.getElementById(`tab-${n.id}`)?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.map((t, i) => (
          <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={active === t.id} aria-controls={`panel-${t.id}`} tabIndex={active === t.id ? 0 : -1}
            onClick={() => setActive(t.id)} onKeyDown={(e) => onKey(e, i)}
            className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", active === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{t.label}</button>
        ))}
      </div>
      {tabs.map((t) => <div key={t.id} id={`panel-${t.id}`} role="tabpanel" aria-labelledby={`tab-${t.id}`} hidden={active !== t.id}>{t.content}</div>)}
    </div>
  );
}
