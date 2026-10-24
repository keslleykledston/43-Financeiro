import { BellRing, FilePlus2, Upload } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listContracts, STATUS_LABEL, type ContractStatus } from "@/modules/contracts/service";
import { listContractAlerts } from "@/modules/contracts/alerts";
import { todayManaus } from "@/modules/messaging/service";
import { Callout, Money, PageHeader, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, selectClass } from "@/components/k3g/button";

const TONE: Record<ContractStatus, StatusTone> = { rascunho: "info", ativo: "positive", suspenso: "warning", encerrado: "neutral" };
const STATUSES = ["rascunho", "ativo", "suspenso", "encerrado"] as const;

export default async function Contratos({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.read")) return <Callout tone="warning">Seu papel não tem acesso a contratos.</Callout>;
  const status = STATUSES.find((s) => s === sp.status);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const [r, al] = await Promise.all([listContracts(db, ctx.user.id, ctx.current.id, { q: sp.q, status, page }), listContractAlerts(db, ctx.user.id, ctx.current.id, todayManaus())]);
  const qs = (o: Record<string, string | undefined>) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ ...sp, ...o })) if (v) u.set(k, v); const s = u.toString(); return s ? `?${s}` : ""; };
  return (
    <div className="space-y-4">
      <PageHeader title="Contratos" description={`${ctx.current.name} · ${r.total} contrato(s). A cobrança só nasce de contratos ativos de clientes ativos.`}
        actions={can(role, "contracts.write") ? <><AppLink href="/contratos/importar" className={buttonClass("outline")}><Upload className="size-4" aria-hidden /> Importar</AppLink><AppLink href="/contratos/novo" className={buttonClass("primary")}><FilePlus2 className="size-4" aria-hidden /> Novo contrato</AppLink></> : undefined} />
      {al.alerts.length > 0 && (
        <Callout tone="warning"><BellRing className="mr-1 inline size-4" aria-hidden /> {al.alerts.length} alerta(s) de vigência ou reajuste. <AppLink href="/contratos/alertas" className="font-medium underline">Ver alertas</AppLink></Callout>
      )}
      <form className="flex flex-wrap gap-2" role="search">
        <label htmlFor="status" className="sr-only">Situação</label>
        <select id="status" name="status" defaultValue={status ?? ""} className={selectClass}><option value="">Todas as situações</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
        <label htmlFor="q" className="sr-only">Buscar</label>
        <input id="q" name="q" defaultValue={sp.q} placeholder="Cliente ou serviço" className="h-10 min-w-[12rem] flex-1 rounded-md border border-input bg-card px-3 text-sm" />
        <button className={buttonClass("outline")}>Buscar</button>
      </form>
      {r.items.length === 0 ? (
        <EmptyState icon={FilePlus2} title={sp.q || status ? "Nenhum contrato encontrado" : "Nenhum contrato ainda"} description="Cadastre o primeiro contrato de um cliente. Depois de aprovado, ele aparece no calendário de faturamento."
          action={can(role, "contracts.write") && !sp.q && !status ? <AppLink href="/contratos/novo" className={buttonClass("primary")}>Novo contrato</AppLink> : undefined} />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {r.items.map((c) => (
            <li key={c.id}>
              <AppLink href={`/contratos/${c.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-accent">
                <div className="min-w-0"><p className="truncate font-medium">{c.customerName}</p><p className="truncate text-sm text-muted-foreground">{c.description} · vence dia {c.dueDay}{c.invoiceJointRequired ? " · NF junto" : ""}</p></div>
                <div className="flex items-center gap-2">
                  {c.pending && c.status !== "rascunho" && <StatusPill tone="info">alteração pendente</StatusPill>}
                  {c.commissionPartner && <StatusPill tone="neutral">comissão {c.commissionPartner}</StatusPill>}
                  {c.customerStatus !== "ativo" && <StatusPill tone="warning">cliente {c.customerStatus}</StatusPill>}
                  <StatusPill tone={TONE[c.status as ContractStatus]}>{c.status === "rascunho" ? "Aguardando aprovação" : STATUS_LABEL[c.status as ContractStatus]}</StatusPill>
                  <Money cents={c.amountCents} className="text-sm font-semibold" />
                </div>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
      {r.pages > 1 && (
        <nav aria-label="Paginação" className="flex items-center justify-between text-sm">
          {r.page > 1 ? <AppLink href={`/contratos${qs({ page: String(r.page - 1) })}`} className={buttonClass("outline", "sm")}>← Anterior</AppLink> : <span />}
          <span>Página {r.page} de {r.pages}</span>
          {r.page < r.pages ? <AppLink href={`/contratos${qs({ page: String(r.page + 1) })}`} className={buttonClass("outline", "sm")}>Próxima →</AppLink> : <span />}
        </nav>
      )}
    </div>
  );
}
