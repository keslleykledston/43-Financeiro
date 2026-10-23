import { CalendarClock, FilePlus2, Users } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { formatBRL } from "@/lib/format";

// DADOS FICTÍCIOS (em centavos) — substituídos por consultas reais, via camada de cálculo no servidor, nas entregas E05–E12.
const KPIS = [
  { label: "Faturado no mês", cents: 18_432_000 },
  { label: "Recebido", cents: 13_187_000 },
  { label: "A receber", cents: 5_245_000 },
  { label: "Em atraso", cents: 921_000 },
];
const LOTES = [["Dia 25", "Vencimentos 1–12"], ["Dia 1", "Vencimentos 13–16 e NF conjunta"], ["Dia 8", "Vencimentos 17–22"], ["Dia 15", "Vencimentos 23–30"]];

export default async function Dashboard() {
  const { current } = await requireContext();
  return (
    <div className="space-y-6">
      <PageHeader title="Visão executiva" description={`${current?.name ?? ""} · Dados fictícios`}
        actions={<AppLink href="/clientes/novo" className={buttonClass("primary")}><Users className="size-4" aria-hidden /> Novo cliente</AppLink>} />
      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-4">
        {KPIS.map((k) => (
          <div key={k.label} className="rounded-lg border bg-card p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{k.label}</p>
            <p className="num mt-2 text-2xl font-semibold">{formatBRL(k.cents)}</p>
            <div className="mt-2"><StatusPill tone="neutral">exemplo</StatusPill></div>
          </div>
        ))}
      </div>
      <SectionCard title="Próximos lotes (exemplo)" action={<CalendarClock className="size-4 text-muted-foreground" aria-hidden />}>
        <ul className="divide-y divide-border text-sm">
          {LOTES.map(([d, t]) => <li key={d} className="flex justify-between py-2"><span className="font-medium">{d}</span><span className="text-muted-foreground">{t}</span></li>)}
        </ul>
        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><FilePlus2 className="size-3.5" aria-hidden /> A simulação de lote chega no E05.</p>
      </SectionCard>
    </div>
  );
}
