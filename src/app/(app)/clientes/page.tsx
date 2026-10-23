import Link from "next/link";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listParties, type Kind } from "@/modules/crm/service";

type SP = { q?: string; tipo?: string; arq?: string; page?: string };

export default async function Clientes({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "crm.read")) {
    return <section className="rounded-2xl bg-white p-8 text-center shadow-sm"><h1 className="text-xl font-semibold">Clientes e fornecedores</h1><p className="mt-2 text-slate-600">Seu papel não tem acesso a este cadastro.</p></section>;
  }
  const kind = sp.tipo === "cliente" || sp.tipo === "fornecedor" ? (sp.tipo as Kind) : undefined;
  const archived = sp.arq === "1";
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const r = await listParties(db, ctx.user.id, ctx.current.id, { q: sp.q, kind, archived, page });
  const qs = (o: Partial<SP>) => { const u = new URLSearchParams(); const m = { ...sp, ...o }; for (const [k, v] of Object.entries(m)) if (v) u.set(k, String(v)); const s = u.toString(); return s ? `?${s}` : ""; };
  const tab = (label: string, v?: string) => (
    <Link key={label} href={`/clientes${qs({ tipo: v, page: undefined })}`} aria-current={(kind ?? "") === (v ?? "") ? "page" : undefined}
      className={`rounded-full px-3 py-1.5 text-sm ${(kind ?? "") === (v ?? "") ? "bg-blue-600 text-white" : "bg-white text-slate-700 ring-1 ring-slate-300"}`}>{label}</Link>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">Clientes e fornecedores</h1><p className="text-sm text-slate-600">{ctx.current.name} · {r.total} {archived ? "arquivados" : "ativos"}</p></div>
        <div className="flex flex-wrap gap-2 text-sm">
          {can(role, "crm.write") && <><Link href="/clientes/novo" className="rounded-xl bg-blue-600 px-4 py-2.5 font-medium text-white">Novo</Link>
          <Link href="/clientes/importar" className="rounded-xl bg-white px-4 py-2.5 ring-1 ring-slate-300">Importar CSV</Link></>}
          {can(role, "crm.export") && <a href="/clientes/exportar" className="rounded-xl bg-white px-4 py-2.5 ring-1 ring-slate-300">Exportar CSV</a>}
        </div>
      </div>
      <form className="flex gap-2" role="search">
        {kind && <input type="hidden" name="tipo" value={kind} />}{archived && <input type="hidden" name="arq" value="1" />}
        <label htmlFor="q" className="sr-only">Buscar</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Buscar por nome ou documento" className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2.5" />
        <button className="rounded-xl bg-white px-4 py-2.5 ring-1 ring-slate-300">Buscar</button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {tab("Todos")}{tab("Clientes", "cliente")}{tab("Fornecedores", "fornecedor")}
        <Link href={`/clientes${qs({ arq: archived ? undefined : "1", page: undefined })}`} className="ml-auto text-sm text-blue-700">{archived ? "Ver ativos" : "Ver arquivados"}</Link>
      </div>
      {r.items.length === 0 ? (
        <section className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <p className="font-medium">{sp.q ? "Nada encontrado para essa busca." : archived ? "Nenhum cadastro arquivado." : "Nenhum cadastro ainda."}</p>
          {!sp.q && !archived && can(role, "crm.write") && <p className="mt-1 text-sm text-slate-600">Cadastre um cliente ou importe uma planilha CSV para começar.</p>}
        </section>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-2xl bg-white shadow-sm">
          {r.items.map((p) => (
            <li key={p.id}><Link href={`/clientes/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
              <div className="min-w-0"><p className="truncate font-medium">{p.legalName}</p><p className="truncate text-sm text-slate-500">{p.docType.toUpperCase()} {p.documentFormatted}</p></div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs">{p.kind === "cliente" ? "Cliente" : "Fornecedor"}</span>
            </Link></li>
          ))}
        </ul>
      )}
      {r.pages > 1 && (
        <nav aria-label="Paginação" className="flex items-center justify-between text-sm">
          {r.page > 1 ? <Link href={`/clientes${qs({ page: String(r.page - 1) })}`} className="rounded-xl bg-white px-4 py-2 ring-1 ring-slate-300">← Anterior</Link> : <span />}
          <span>Página {r.page} de {r.pages}</span>
          {r.page < r.pages ? <Link href={`/clientes${qs({ page: String(r.page + 1) })}`} className="rounded-xl bg-white px-4 py-2 ring-1 ring-slate-300">Próxima →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
