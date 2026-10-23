import Link from "next/link";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCustomerMode, listParties, STATUS_LABEL, type Kind, type Status } from "@/modules/crm/service";

type SP = { q?: string; tipo?: string; arq?: string; page?: string; situacao?: string };

export default async function Clientes({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "crm.read")) {
    return <section className="rounded-lg border bg-card p-8 text-center"><h1 className="text-xl font-semibold">Clientes e fornecedores</h1><p className="mt-2 text-muted-foreground">Seu papel não tem acesso a este cadastro.</p></section>;
  }
  const kind = sp.tipo === "cliente" || sp.tipo === "fornecedor" ? (sp.tipo as Kind) : undefined;
  const archived = sp.arq === "1";
  const situacao = (["ativo", "suspenso", "cancelado"] as const).find((x) => x === sp.situacao) as Status | undefined;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const mode = await getCustomerMode(db, ctx.user.id, ctx.current.id);
  const r = await listParties(db, ctx.user.id, ctx.current.id, { q: sp.q, kind, status: situacao, archived, page });
  const qs = (o: Partial<SP>) => { const u = new URLSearchParams(); const m = { ...sp, ...o }; for (const [k, v] of Object.entries(m)) if (v) u.set(k, String(v)); const s = u.toString(); return s ? `?${s}` : ""; };
  const tab = (label: string, v?: string) => (
    <Link key={label} href={`/clientes${qs({ tipo: v, page: undefined })}`} aria-current={(kind ?? "") === (v ?? "") ? "page" : undefined}
      className={`rounded-full px-3 py-1.5 text-sm ${(kind ?? "") === (v ?? "") ? "bg-primary text-primary-foreground" : "bg-card text-foreground ring-1 ring-input"}`}>{label}</Link>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-2xl font-semibold">Clientes e fornecedores</h1><p className="text-sm text-muted-foreground">{ctx.current.name} · {r.total} {archived ? "arquivados" : "ativos"}</p></div>
        <div className="flex flex-wrap gap-2 text-sm">
          {can(role, "crm.write") && <><Link href="/clientes/novo" className="rounded-md bg-primary px-4 py-2.5 font-medium text-primary-foreground">Novo</Link>
          <Link href="/clientes/importar" className="rounded-md bg-card px-4 py-2.5 ring-1 ring-input">Importar CSV</Link></>}
          {can(role, "crm.export") && <a href="/clientes/exportar" className="rounded-md bg-card px-4 py-2.5 ring-1 ring-input">Exportar CSV</a>}
        </div>
      </div>
      {mode === "crm" && <p role="note" className="rounded-md bg-info-soft p-3 text-sm text-info-foreground">Os <strong>clientes</strong> desta empresa vêm do CRM (somente leitura). Fornecedores continuam locais. <Link href="/integracoes" className="underline">Integrações</Link></p>}
      <form className="flex flex-wrap gap-2" role="search">
        {kind && <input type="hidden" name="tipo" value={kind} />}{archived && <input type="hidden" name="arq" value="1" />}
        <label htmlFor="situacao" className="sr-only">Situação</label>
        <select id="situacao" name="situacao" defaultValue={situacao ?? ""} className="h-10 rounded-md border border-input bg-card px-2 text-sm"><option value="">Todas as situações</option><option value="ativo">Ativos</option><option value="suspenso">Suspensos</option><option value="cancelado">Cancelados</option></select>
        <label htmlFor="q" className="sr-only">Buscar</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Buscar por nome ou documento" className="min-w-[12rem] flex-1 rounded-md border border-input bg-card px-3 py-2.5" />
        <button className="rounded-md bg-card px-4 py-2.5 ring-1 ring-input">Buscar</button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {tab("Todos")}{tab("Clientes", "cliente")}{tab("Fornecedores", "fornecedor")}
        <Link href={`/clientes${qs({ arq: archived ? undefined : "1", page: undefined })}`} className="ml-auto text-sm text-primary">{archived ? "Ver ativos" : "Ver arquivados"}</Link>
      </div>
      {r.items.length === 0 ? (
        <section className="rounded-lg border bg-card p-8 text-center">
          <p className="font-medium">{sp.q ? "Nada encontrado para essa busca." : archived ? "Nenhum cadastro arquivado." : "Nenhum cadastro ainda."}</p>
          {!sp.q && !archived && can(role, "crm.write") && <p className="mt-1 text-sm text-muted-foreground">Cadastre um cliente ou importe uma planilha CSV para começar.</p>}
        </section>
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {r.items.map((p) => (
            <li key={p.id}><Link href={`/clientes/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent">
              <div className="min-w-0"><p className="truncate font-medium">{p.legalName}</p><p className="truncate text-sm text-muted-foreground">{p.docType.toUpperCase()} {p.documentFormatted}</p></div>
              <span className="flex shrink-0 gap-1.5"><span className="rounded-full bg-muted px-2.5 py-1 text-xs">{p.kind === "cliente" ? "Cliente" : "Fornecedor"}</span>{p.kind === "cliente" && p.status !== "ativo" && <span className={`rounded-full px-2.5 py-1 text-xs ${p.status === "cancelado" ? "bg-negative-soft text-negative-foreground" : "bg-warning-soft text-warning-foreground"}`}>{STATUS_LABEL[p.status as Status]}</span>}{p.source === "crm" && <span className="rounded-full bg-info-soft px-2.5 py-1 text-xs text-info-foreground">CRM</span>}</span>
            </Link></li>
          ))}
        </ul>
      )}
      {r.pages > 1 && (
        <nav aria-label="Paginação" className="flex items-center justify-between text-sm">
          {r.page > 1 ? <Link href={`/clientes${qs({ page: String(r.page - 1) })}`} className="rounded-md bg-card px-4 py-2 ring-1 ring-input">← Anterior</Link> : <span />}
          <span>Página {r.page} de {r.pages}</span>
          {r.page < r.pages ? <Link href={`/clientes${qs({ page: String(r.page + 1) })}`} className="rounded-md bg-card px-4 py-2 ring-1 ring-input">Próxima →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
