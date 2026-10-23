import { ArrowLeft, FileCheck2 } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { KIND_LABEL, STATUS_LABEL, getIssuanceSettings, listIssuance } from "@/modules/issuance/service";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { cancelIssuanceAction, processIssuanceAction, saveIssuanceSettingsAction } from "./actions";

const TONE: Record<string, StatusTone> = { pendente: "info", enviando: "info", processando: "warning", emitido: "positive", desconhecido: "warning", falhou: "negative", cancelado: "neutral" };
const br = (d: string) => d.split("-").reverse().join("/");

function okText(ok?: string) {
  const [k, ...n] = (ok ?? "").split(":"); const v = n.map(Number);
  if (k === "solicitado") return `${v[0]} solicitação(ões) criada(s).`;
  if (k === "rodada") return `Rodada simulada: ${v[0]} emitido(s), ${v[1]} em processamento, ${v[2]} a reconsultar, ${v[3]} para repetir, ${v[4]} com falha, ${v[5]} dispensado(s).${n[6] ? ` Aviso: ${decodeURIComponent(n[6])}.` : ""}`;
  if (k === "cancelado") return "Solicitação cancelada.";
  if (k === "salvo") return "Configuração salva.";
  return "";
}

export default async function Emissoes({ searchParams }: { searchParams: Promise<{ status?: string; erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "issuance.read")) return <Callout tone="warning">Seu papel não tem acesso às emissões.</Callout>;
  const [st, { items, counts }] = await Promise.all([getIssuanceSettings(db, ctx.user.id, ctx.current.id), listIssuance(db, ctx.user.id, ctx.current.id, sp.status)]);
  const run = can(role, "issuance.run"), request = can(role, "issuance.request"), manage = can(role, "issuance.manage");
  const msg = okText(sp.ok);

  return (
    <div className="space-y-5">
      <PageHeader title="Emissões" description={`${ctx.current.name} · boletos e NFS-e (motor simulado).`}
        actions={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Lotes</AppLink>} />
      <Callout tone="info">Simulação: este motor ensaia o fluxo (reservar, chamar o provedor, registrar, reconsultar quando a resposta se perde), mas <strong>nenhum boleto ou nota real é emitido</strong>. A emissão real só será ligada com credenciais, homologação e autorização escrita da diretoria.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {msg && <Callout tone="positive" role="status">{msg}</Callout>}

      <SectionCard title="Controle" action={run ? <form action={processIssuanceAction}><button className={buttonClass("primary", "sm")}>Processar agora (simulado)</button></form> : undefined}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {st.paused ? <StatusPill tone="negative">Emissão pausada</StatusPill> : <StatusPill tone="positive">Emissão liberada (simulada)</StatusPill>}
          <span className="text-muted-foreground">Limite diário: {st.dailyLimit}</span>
        </div>
        <form action={saveIssuanceSettingsAction} className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="paused" defaultChecked={st.paused} disabled={!manage} className="size-4 accent-primary" /> Pausar emissão (chave de emergência; vem pausada)</label>
          <div><label htmlFor="dailyLimit" className="mb-1 block text-xs font-medium">Limite diário</label><input id="dailyLimit" name="dailyLimit" type="number" min={1} max={500} defaultValue={st.dailyLimit} disabled={!manage} className={`${inputClass} w-28`} /></div>
          {manage ? <button className={buttonClass("outline", "sm")}>Salvar</button> : <span className="text-xs text-muted-foreground">Só a diretoria altera.</span>}
        </form>
      </SectionCard>

      <SectionCard title="Solicitações">
        <nav aria-label="Filtrar" className="mb-3 flex flex-wrap gap-2 text-sm">
          <AppLink href="/faturamento/emissoes" className={buttonClass(sp.status ? "ghost" : "outline", "sm")}>Todas</AppLink>
          {Object.keys(STATUS_LABEL).map((s) => <AppLink key={s} href={`/faturamento/emissoes?status=${s}`} className={buttonClass(sp.status === s ? "outline" : "ghost", "sm")}>{s} · {counts[s] ?? 0}</AppLink>)}
        </nav>
        {items.length === 0 ? (
          <EmptyState icon={FileCheck2} title="Nenhuma solicitação" description="Aprove um lote e use “Solicitar boletos” ou “Solicitar NFS-e” na página do lote." action={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}>Lotes</AppLink>} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <AppLink href={`/contas-a-receber/${i.chargeId}`} className="font-medium hover:underline">{i.customerName}</AppLink>
                  <p className="text-xs text-muted-foreground">{KIND_LABEL[i.kind]} · vence {br(i.dueDate)} · {i.attempts} tentativa(s){i.lastError ? ` · ${i.lastError}` : ""}{i.externalRef ? ` · ref. ${i.externalRef}` : ""}</p>
                </div>
                <span className="flex items-center gap-3"><Money cents={i.amountCents} /><StatusPill tone={TONE[i.status]}>{STATUS_LABEL[i.status]}</StatusPill>
                  {request && i.status === "pendente" && <form action={cancelIssuanceAction}><input type="hidden" name="id" value={i.id} /><button className={buttonClass("ghost", "sm")}>Cancelar</button></form>}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
