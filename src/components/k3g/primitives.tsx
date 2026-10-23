import type { ReactNode } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, TrendingDown, TrendingUp, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBRL, formatPct, type Cents } from "@/lib/format";

export type Severity = "critical" | "warning" | "info" | "positive";
export type PartyKind = "cliente" | "fornecedor";

export function Money({ cents, className }: { cents: Cents; className?: string }) {
  return <span className={cn("num", className)}>{formatBRL(cents)}</span>;
}

/* ---------- Selos semânticos (ícone + texto, nunca só cor) ---------- */
const severityMap: Record<Severity, { label: string; icon: typeof Info; cls: string }> = {
  critical: { label: "Crítico", icon: AlertOctagon, cls: "bg-negative-soft text-negative-foreground" },
  warning: { label: "Atenção", icon: AlertTriangle, cls: "bg-warning-soft text-warning-foreground" },
  info: { label: "Informação", icon: Info, cls: "bg-info-soft text-info-foreground" },
  positive: { label: "Positivo", icon: CheckCircle2, cls: "bg-positive-soft text-positive-foreground" },
};
export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = severityMap[severity]; const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide", s.cls)}>
      <Icon className="size-3.5" aria-hidden />{s.label}
    </span>
  );
}

export type StatusTone = "positive" | "negative" | "warning" | "info" | "neutral";
const toneCls: Record<StatusTone, string> = {
  positive: "bg-positive-soft text-positive-foreground", negative: "bg-negative-soft text-negative-foreground",
  warning: "bg-warning-soft text-warning-foreground", info: "bg-info-soft text-info-foreground", neutral: "bg-muted text-muted-foreground",
};
const toneIcon: Record<StatusTone, typeof Info | null> = { positive: CheckCircle2, negative: XCircle, warning: AlertTriangle, info: Info, neutral: null };
export function StatusPill({ tone, children, icon }: { tone: StatusTone; children: ReactNode; icon?: typeof Info | null }) {
  const Icon = icon === undefined ? toneIcon[tone] : icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", toneCls[tone])}>
      {Icon && <Icon className="size-3.5" aria-hidden />}{children}
    </span>
  );
}

const kindLabel: Record<PartyKind, string> = { cliente: "Cliente", fornecedor: "Fornecedor" };
export function PartyKindBadge({ kind }: { kind: PartyKind }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
      kind === "fornecedor" ? "border-border bg-muted text-foreground" : "border-primary/30 bg-primary-soft text-accent-foreground")}>
      {kindLabel[kind]}
    </span>
  );
}
/** Selo de origem do cadastro (CRM). */
export const SourceBadge = ({ source }: { source: string }) =>
  source === "crm" ? <span className="inline-flex items-center rounded-md border border-info/30 bg-info-soft px-1.5 py-0.5 text-[11px] font-medium text-info-foreground">CRM</span> : null;

export const SoonTag = () => <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">em breve</span>;

/** Variação % com ícone + texto. `higherIsBetter=false` inverte a semântica. */
export function Delta({ ratio, higherIsBetter = true }: { ratio: number; higherIsBetter?: boolean }) {
  const up = ratio >= 0; const good = up === higherIsBetter; const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", good ? "text-positive-foreground" : "text-negative-foreground")}>
      <Icon className="size-3.5" aria-hidden /><span className="num">{formatPct(ratio)}</span><span className="sr-only">{good ? "(favorável)" : "(desfavorável)"}</span>
    </span>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function SectionCard({ title, action, children, className }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border bg-card p-4 sm:p-6", className)}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Aviso em linha (nota/alerta/sucesso) com a semântica certa para leitores de tela. */
export function Callout({ tone = "info", children, role = "note", className }: { tone?: "info" | "positive" | "warning" | "negative"; children: ReactNode; role?: "note" | "status" | "alert"; className?: string }) {
  const cls = { info: "bg-info-soft text-info-foreground", positive: "bg-positive-soft text-positive-foreground", warning: "bg-warning-soft text-warning-foreground", negative: "bg-negative-soft text-negative-foreground" }[tone];
  return <div role={role} className={cn("rounded-md p-3 text-sm", cls, className)}>{children}</div>;
}
