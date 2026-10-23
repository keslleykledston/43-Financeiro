import { requireContext } from "@/lib/security/context";

// DADOS FICTÍCIOS — substituídos por consultas reais nas entregas E05–E12.
const KPIS = [
  { label: "Faturado no mês", value: "R$ 184.320,00" },
  { label: "Recebido", value: "R$ 131.870,00" },
  { label: "A receber", value: "R$ 52.450,00" },
  { label: "Em atraso", value: "R$ 9.210,00" },
];

export default async function Dashboard() {
  const { current } = await requireContext();
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Visão executiva</h1>
        <p className="text-sm text-slate-600">{current?.name} · <span className="font-medium text-amber-700">Dados fictícios</span></p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {KPIS.map((k) => (
          <div key={k.label} className="rounded-2xl bg-white p-4 shadow-sm">
            <p className="text-xs text-slate-500">{k.label}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums sm:text-xl">{k.value}</p>
          </div>
        ))}
      </div>
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="font-semibold">Próximos lotes (exemplo)</h2>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {[["Dia 25", "Vencimentos 1–12"], ["Dia 1", "Vencimentos 13–16 e NF conjunta"], ["Dia 8", "Vencimentos 17–22"], ["Dia 15", "Vencimentos 23–30"]].map(([d, t]) => (
            <li key={d} className="flex justify-between py-2"><span className="font-medium">{d}</span><span className="text-slate-600">{t}</span></li>
          ))}
        </ul>
      </section>
    </div>
  );
}
