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

const REASON: Record<string, string> = { duplicate_document: "Já existe um cadastro local com este documento", document_collision: "O documento colide com outro cadastro ativo", ambiguous_company: "Não foi possível saber a qual empresa pertence" };
const fmt = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "America/Manaus" });

export default async function Integracoes() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "crm.read")) {
    return <section className="rounded-2xl bg-white p-8 text-center shadow-sm"><h1 className="text-xl font-semibold">Integrações</h1><p className="mt-2 text-slate-600">Seu papel não tem acesso às integrações.</p></section>;
  }
  const manage = can(role, "integrations.manage") && can(role, "crm.write");
  const mode = await getCustomerMode(db, ctx.user.id, ctx.current.id);
  const [conn, conflicts, runs] = await Promise.all([getConnection(db, ctx.current.id), listConflicts(db, ctx.user.id, ctx.current.id), listRuns(db, ctx.user.id, ctx.current.id)]);
  const master = process.env.CRM_SYNC_ENABLED === "true";
  const configured = !!process.env.CRM_BASE_URL && !!process.env.CRM_API_TOKEN;
  return (
    <div className="max-w-3xl space-y-5">
      <div><h1 className="text-2xl font-semibold">Integrações</h1><p className="text-sm text-slate-600">{ctx.current.name}</p></div>
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">Origem dos clientes</h2>
        <p className="mb-3 text-sm text-slate-600">Escolha, para esta empresa, onde os clientes são mantidos. Atual: <strong>{mode === "crm" ? "CRM" : "Local"}</strong>.</p>
        <ModeForm mode={mode} canChange={manage} />
      </section>
      {mode === "local" ? (
        <p role="note" className="rounded-2xl bg-white p-5 text-sm text-slate-600 shadow-sm">No modo <strong>Local</strong> a integração com o CRM está desligada. Para importar clientes do CRM, mude a origem para <strong>CRM</strong>.</p>
      ) : (<>
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">CRM — clientes e contratos</h2>
        <p className="mb-3 text-sm text-slate-600">O CRM é a fonte de verdade. O K3G Finance só <strong>lê</strong> dados dele; nunca grava no CRM. Cadastros vindos do CRM ficam somente leitura aqui.</p>
        <ul className="mb-3 space-y-1 text-sm">
          <li>Chave geral do servidor: <strong>{master ? "ligada" : "desligada"}</strong></li>
          <li>Credenciais no servidor: <strong>{configured ? "configuradas" : "não configuradas"}</strong></li>
          <li>Nesta empresa: <strong>{conn?.enabled ? "ativada" : "desativada"}</strong>{conn?.lastRunAt && <> · última sincronização {fmt(conn.lastRunAt)}</>}</li>
        </ul>
        {manage ? <ConnectionForm enabled={!!conn?.enabled} companyRef={(conn?.settings as { companyRef?: string } | undefined)?.companyRef} /> : <p className="text-sm text-slate-500">Somente a diretoria altera a configuração.</p>}
      </section>
      {manage && <section className="rounded-2xl bg-white p-5 shadow-sm"><h2 className="mb-3 font-semibold">Sincronizar clientes</h2><SyncPanel /></section>}
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">Conflitos para revisar ({conflicts.length})</h2>
        {conflicts.length === 0 && <p className="text-sm text-slate-500">Nenhum conflito aberto.</p>}
        <ul className="divide-y divide-slate-100">
          {conflicts.map((c) => {
            const p = c.payload as { legalName?: string; document?: string };
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0"><p className="truncate font-medium">{p.legalName} <span className="font-normal text-slate-500">{p.document}</span></p><p className="text-slate-500">{REASON[c.reason] ?? c.reason}</p></div>
                {manage && (
                  <form action={resolveAction} className="flex gap-2">
                    <input type="hidden" name="conflictId" value={c.id} />
                    {c.localId && <button name="action" value="link" className="rounded-lg bg-white px-3 py-1.5 ring-1 ring-slate-300">Vincular ao cadastro existente</button>}
                    <button name="action" value="ignore" className="rounded-lg px-3 py-1.5 text-slate-600 ring-1 ring-slate-200">Ignorar</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">Execuções recentes</h2>
        {runs.length === 0 && <p className="text-sm text-slate-500">Nenhuma execução ainda.</p>}
        <ul className="space-y-1 text-sm text-slate-600">
          {runs.map((r) => { const s = r.stats as Record<string, number>; return <li key={r.id}>{fmt(r.createdAt)} — {r.status === "applied" ? `aplicada (${s.create ?? 0} novos, ${s.update ?? 0} alterados, ${s.archive ?? 0} arquivados, ${s.conflict ?? 0} conflitos)` : `falhou: ${r.error ?? "erro"}`}</li>; })}
        </ul>
      </section>
      </>)}
    </div>
  );
}
