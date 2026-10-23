import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCustomerMode } from "@/modules/crm/service";
import { getConnection, listConflicts, listRuns } from "@/modules/integrations/crm/sync";
import { ConnectionForm } from "./connection-form";
import { ModeForm } from "./mode-form";
import { SyncPanel } from "./sync-panel";
import { resolveAction } from "./actions";
import { PROVIDER_CATALOG, liveFlagsOn } from "@/modules/providers/registry";

const REASON: Record<string, string> = { duplicate_document: "Já existe um cadastro local com este documento", document_collision: "O documento colide com outro cadastro ativo", ambiguous_company: "Não foi possível saber a qual empresa pertence" };
const fmt = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "America/Manaus" });

export default async function Integracoes() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "crm.read")) {
    return <section className="rounded-lg border bg-card p-8 text-center"><h1 className="text-xl font-semibold">Integrações</h1><p className="mt-2 text-muted-foreground">Seu papel não tem acesso às integrações.</p></section>;
  }
  const manage = can(role, "integrations.manage") && can(role, "crm.write");
  const mode = await getCustomerMode(db, ctx.user.id, ctx.current.id);
  const [conn, conflicts, runs] = await Promise.all([getConnection(db, ctx.current.id), manage ? listConflicts(db, ctx.user.id, ctx.current.id) : Promise.resolve([]), listRuns(db, ctx.user.id, ctx.current.id)]);
  const master = process.env.CRM_SYNC_ENABLED === "true";
  const configured = !!process.env.CRM_BASE_URL && !!process.env.CRM_API_TOKEN;
  return (
    <div className="max-w-3xl space-y-5">
      <div><h1 className="text-2xl font-semibold">Integrações</h1><p className="text-sm text-muted-foreground">{ctx.current.name}</p></div>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-1 font-semibold">Origem dos clientes</h2>
        <p className="mb-3 text-sm text-muted-foreground">Escolha, para esta empresa, onde os clientes são mantidos. Atual: <strong>{mode === "crm" ? "CRM" : "Local"}</strong>.</p>
        <ModeForm mode={mode} canChange={manage} />
      </section>
      {mode === "local" ? (
        <p role="note" className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">No modo <strong>Local</strong> a integração com o CRM está desligada. Para importar clientes do CRM, mude a origem para <strong>CRM</strong>.</p>
      ) : (<>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-1 font-semibold">CRM — clientes e contratos</h2>
        <p className="mb-3 text-sm text-muted-foreground">O CRM é a fonte de verdade. O K3G Finance só <strong>lê</strong> dados dele; nunca grava no CRM. Cadastros vindos do CRM ficam somente leitura aqui.</p>
        <ul className="mb-3 space-y-1 text-sm">
          <li>Chave geral do servidor: <strong>{master ? "ligada" : "desligada"}</strong></li>
          <li>Credenciais no servidor: <strong>{configured ? "configuradas" : "não configuradas"}</strong></li>
          <li>Nesta empresa: <strong>{conn?.enabled ? "ativada" : "desativada"}</strong>{conn?.lastRunAt && <> · última sincronização {fmt(conn.lastRunAt)}</>}</li>
        </ul>
        {manage ? <ConnectionForm enabled={!!conn?.enabled} companyRef={(conn?.settings as { companyRef?: string } | undefined)?.companyRef} /> : <p className="text-sm text-muted-foreground">Somente a diretoria altera a configuração.</p>}
      </section>
      {manage && <section className="rounded-lg border bg-card p-5"><h2 className="mb-3 font-semibold">Sincronizar clientes</h2><SyncPanel /></section>}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">Conflitos para revisar ({conflicts.length})</h2>
        {conflicts.length === 0 && <p className="text-sm text-muted-foreground">Nenhum conflito aberto.</p>}
        <ul className="divide-y divide-border">
          {conflicts.map((c) => {
            const p = c.payload as { legalName?: string; document?: string };
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0"><p className="truncate font-medium">{p.legalName} <span className="font-normal text-muted-foreground">{p.document}</span></p><p className="text-muted-foreground">{REASON[c.reason] ?? c.reason}</p></div>
                {manage && (
                  <form action={resolveAction} className="flex gap-2">
                    <input type="hidden" name="conflictId" value={c.id} />
                    {c.localId && <button name="action" value="link" className="rounded-lg border bg-card px-3 py-1.5 ring-1 ring-input">Vincular ao cadastro existente</button>}
                    <button name="action" value="ignore" className="rounded-lg px-3 py-1.5 text-muted-foreground ring-1 ring-border">Ignorar</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">Execuções recentes</h2>
        {runs.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma execução ainda.</p>}
        <ul className="space-y-1 text-sm text-muted-foreground">
          {runs.map((r) => { const s = r.stats as Record<string, number>; return <li key={r.id}>{fmt(r.createdAt)} — {r.status === "applied" ? `aplicada (${s.create ?? 0} novos, ${s.update ?? 0} alterados, ${s.archive ?? 0} arquivados, ${s.conflict ?? 0} conflitos)` : `falhou: ${r.error ?? "erro"}`}</li>; })}
        </ul>
      </section>
      </>)}
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-1 font-semibold">Provedores de cobrança e mensagens</h2>
        <p className="mb-3 text-sm text-muted-foreground">Hoje todos funcionam em <strong>modo simulado</strong>: nada é emitido nem enviado de verdade. Cada provedor real entra numa fase própria, só com credenciais fora do Git, homologação e autorização.</p>
        {liveFlagsOn().length > 0 && <p role="alert" className="mb-3 rounded-md bg-negative-soft p-3 text-sm text-negative-foreground">Atenção: há chave(s) real(is) ligada(s) ({liveFlagsOn().join(", ")}) sem adaptador homologado. O envio fica bloqueado até desligá-las.</p>}
        <ul className="divide-y divide-border text-sm">
          {PROVIDER_CATALOG.map((p) => (
            <li key={p.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div><p className="font-medium">{p.label}</p><p className="text-xs text-muted-foreground">{p.note}</p></div>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">Simulado · chave {process.env[p.flag] === "true" ? "LIGADA" : "desligada"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
