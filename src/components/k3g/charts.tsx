import { formatBRL } from "@/lib/format";

/** Gráficos em SVG puro (sem biblioteca), com tabela alternativa para leitor de tela. Cores só por tokens do tema. */
const W = 640, H = 220, PAD = { l: 8, r: 8, t: 12, b: 28 };
const compact = (c: number) => { const v = Math.abs(c) / 100; return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : `${Math.round(v)}`; };
const mm = (iso: string) => iso.slice(5, 7) + "/" + iso.slice(2, 4);
const dm = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);

export function PairedBars({ title, data, labelA, labelB }: { title: string; data: { month: string; a: number; b: number }[]; labelA: string; labelB: string }) {
  const max = Math.max(1, ...data.flatMap((d) => [d.a, d.b]));
  const gw = (W - PAD.l - PAD.r) / data.length, bw = Math.min(28, gw / 3);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full">
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="stroke-border" />
        {data.map((d, i) => {
          const cx = PAD.l + gw * i + gw / 2;
          return (
            <g key={d.month}>
              <rect x={cx - bw - 2} y={y(d.a)} width={bw} height={H - PAD.b - y(d.a)} rx={3} className="fill-chart-1"><title>{`${labelA} ${mm(d.month + "-01")}: ${formatBRL(d.a)}`}</title></rect>
              <rect x={cx + 2} y={y(d.b)} width={bw} height={H - PAD.b - y(d.b)} rx={3} className="fill-chart-4"><title>{`${labelB} ${mm(d.month + "-01")}: ${formatBRL(d.b)}`}</title></rect>
              <text x={cx} y={H - 10} textAnchor="middle" className="fill-muted-foreground text-[11px]">{mm(d.month + "-01")}</text>
              {d.a > 0 && <text x={cx - bw / 2 - 2} y={y(d.a) - 4} textAnchor="middle" className="fill-foreground text-[10px]">{compact(d.a)}</text>}
              {d.b > 0 && <text x={cx + bw / 2 + 2} y={y(d.b) - 4} textAnchor="middle" className="fill-foreground text-[10px]">{compact(d.b)}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-1" aria-hidden />{labelA}</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-4" aria-hidden />{labelB}</span>
      </figcaption>
      <div className="sr-only"><table><caption>{title}</caption><thead><tr><th>Mês</th><th>{labelA}</th><th>{labelB}</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.month}><td>{d.month}</td><td>{formatBRL(d.a)}</td><td>{formatBRL(d.b)}</td></tr>)}</tbody></table></div>
    </figure>
  );
}

/** Classes completas (literais) para o Tailwind enxergá-las. */
type Palette = { fillA: string; fillB: string; bgA: string; bgB: string };
export const PALETTE_IN: Palette = { fillA: "fill-chart-1", fillB: "fill-chart-2", bgA: "bg-chart-1", bgB: "bg-chart-2" };
export const PALETTE_OUT: Palette = { fillA: "fill-chart-3", fillB: "fill-chart-4", bgA: "bg-chart-3", bgB: "bg-chart-4" };
export function ForecastBars({ title, weeks, labelA = "Confirmado (cobrança aprovada)", labelB = "Previsto pelos contratos (ainda não emitido)", short = ["confirmado", "previsto por contrato"], palette = PALETTE_IN }: { title: string; weeks: { start: string; end: string; confirmedCents: number; plannedCents: number }[]; labelA?: string; labelB?: string; short?: [string, string]; palette?: Palette }) {
  const max = Math.max(1, ...weeks.map((w) => w.confirmedCents + w.plannedCents));
  const gw = (W - PAD.l - PAD.r) / weeks.length, bw = Math.min(30, gw - 6);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full">
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} className="stroke-border" />
        {weeks.map((w, i) => {
          const cx = PAD.l + gw * i + gw / 2, x = cx - bw / 2, total = w.confirmedCents + w.plannedCents;
          return (
            <g key={w.start}>
              <rect x={x} y={y(w.confirmedCents)} width={bw} height={H - PAD.b - y(w.confirmedCents)} rx={2} className={palette.fillA}><title>{`Semana de ${dm(w.start)} a ${dm(w.end)} — ${short[0]}: ${formatBRL(w.confirmedCents)}`}</title></rect>
              {w.plannedCents > 0 && <rect x={x} y={y(total)} width={bw} height={y(w.confirmedCents) - y(total)} rx={2} className={palette.fillB} opacity={0.85}><title>{`Semana de ${dm(w.start)} a ${dm(w.end)} — ${short[1]}: ${formatBRL(w.plannedCents)}`}</title></rect>}
              <text x={cx} y={H - 10} textAnchor="middle" className="fill-muted-foreground text-[9px]">{dm(w.start)}</text>
              {total > 0 && <text x={cx} y={y(total) - 4} textAnchor="middle" className="fill-foreground text-[9px]">{compact(total)}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${palette.bgA}`} aria-hidden />{labelA}</span>
        <span className="inline-flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${palette.bgB}`} aria-hidden />{labelB}</span>
      </figcaption>
      <div className="sr-only"><table><caption>{title}</caption><thead><tr><th>Semana</th><th>{short[0]}</th><th>{short[1]}</th></tr></thead>
        <tbody>{weeks.map((w) => <tr key={w.start}><td>{w.start} a {w.end}</td><td>{formatBRL(w.confirmedCents)}</td><td>{formatBRL(w.plannedCents)}</td></tr>)}</tbody></table></div>
    </figure>
  );
}
