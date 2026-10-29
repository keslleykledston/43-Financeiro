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
import { BOLETO_PROVIDER_MODES, LIVE_CANARY_DAILY_MAX, LIVE_CONFIRM_PHRASE, MODE_LABEL, coraStageOn, prodEmissionOn } from "@/modules/providers/registry";
import { cancelIssuanceAction, processIssuanceAction, saveIssuanceSettingsAction, syncBoletoStatusAction } from "./actions";

const TONE: Record<string, StatusTone> = { pendente: "info", enviando: "info", processando: "warning", emitido: "positive", desconhecido: "warning", falhou: "negative", cancelado: "neutral" };
const br = (d: string) => d.split("-").reverse().join("/");

function okText(ok?: string, mode = "simulado") {
  const stage = mode === "cora_homologacao", prod = mode === "cora_producao";
  const [k, ...n] = (ok ?? "").split(":"); const v = n.map(Number);
  if (k === "solicitado") return `${v[0]} solicitação(ões) criada(s).`;
  if (k === "rodada") return `${prod ? "Rodada na Cora de PRODUÇÃO (boletos reais)" : stage ? "Rodada na Cora de testes" : "Rodada simulada"}: ${v[0]} emitido(s), ${v[1]} em processamento, ${v[2]} a reconsultar, ${v[3]} para repetir, ${v[4]} com falha, ${v[5]} dispensado(s).${n[6] ? ` Aviso: ${decodeURIComponent(n[6])}.` : ""}`;
  if (k === "sync") return `Situação conferida na ${prod ? "Cora (produção)" : "Cora de testes"}: ${v[0]} boleto(s) consultado(s), ${v[1]} pago(s), ${v[2]} cancelado(s) lá fora, ${v[3]} com falha. Baixas automáticas feitas: ${v[4]}; pagos aguardando conferência: ${v[5]}.${n[6] ? ` Aviso: ${decodeURIComponent(n[6])}` : ""}`;
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
  const stage = st.boletoProvider === "cora_homologacao", prod = st.boletoProvider === "cora_producao", real = stage || prod, stageOn = coraStageOn(), prodOn = prodEmissionOn();
  const msg = okText(sp.ok, st.boletoProvider);

  return (
    <div className="space-y-5">
      <PageHeader title="Emissões" description={`${ctx.current.name} · boletos e NFS-e (${prod ? "boletos REAIS na Cora (produção)" : stage ? "boletos na Cora de testes" : "motor simulado"}).`}
        actions={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Lotes</AppLink>} />
      {prod && <Callout tone="negative" role="alert"><strong>Atenção: emissão REAL.</strong> Os boletos desta empresa são criados na <strong>Cora de PRODUÇÃO</strong>: são boletos de verdade, que cobram o cliente. {st.liveCanary ? <>Modo <strong>canário</strong>: no máximo {LIVE_CANARY_DAILY_MAX} boletos reais por dia. </> : <>Modo canário desligado: vale o limite diário. </>}Antes de emitir, a plataforma confere se a Cora já tem um boleto igual para o mesmo cliente e vencimento (se tiver, <strong>não emite</strong> e avisa). NFS-e, e-mail e WhatsApp seguem simulados/desligados. Para parar: <strong>marque “Pausar emissão”</strong>.</Callout>}
      <Callout tone="info">{prod ? <>Modo de produção ligado para esta empresa{st.liveAuthorizedAt ? ` (autorizado em ${st.liveAuthorizedAt.toLocaleString("pt-BR", { timeZone: "America/Manaus" })})` : ""}. Cada rodada pede confirmação.</> : stage
        ? <>Os boletos desta empresa vão para a <strong>Cora de testes (homologação)</strong>: o boleto nasce lá, com número e linha digitável de teste, mas <strong>não é um boleto real e não cobra ninguém</strong>. NFS-e continua simulada. A emissão em produção só será ligada com autorização escrita da diretoria.</>
        : <>Simulação: este motor ensaia o fluxo (reservar, chamar o provedor, registrar, reconsultar quando a resposta se perde), mas <strong>nenhum boleto ou nota real é emitido</strong>. A emissão real só será ligada com credenciais, homologação e autorização escrita da diretoria.</>}</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {msg && <Callout tone="positive" role="status">{msg}</Callout>}

      <SectionCard title="Controle" action={run ? <span className="flex flex-wrap items-center gap-2">{real && <form action={syncBoletoStatusAction}><button className={buttonClass("outline", "sm")}>Atualizar situação na Cora</button></form>}<form action={processIssuanceAction} className="flex flex-wrap items-center gap-2">{prod && <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" name="confirmLive" required className="size-4 accent-primary" /> Confirmo: são boletos REAIS</label>}<button className={buttonClass(prod ? "danger" : "primary", "sm")}>Processar agora{prod ? " (PRODUÇÃO — real)" : stage ? " (Cora de testes)" : " (simulado)"}</button></form></span> : undefined}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          {st.paused ? <StatusPill tone="negative">Emissão pausada</StatusPill> : <StatusPill tone={prod ? "warning" : "positive"}>{prod ? "Emissão liberada (PRODUÇÃO)" : stage ? "Emissão liberada (Cora de testes)" : "Emissão liberada (simulada)"}</StatusPill>}
          <span className="text-muted-foreground">Limite diário: {st.dailyLimit}</span>
        </div>
        <form action={saveIssuanceSettingsAction} className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="paused" defaultChecked={st.paused} disabled={!manage} className="size-4 accent-primary" /> Pausar emissão (chave de emergência; vem pausada)</label>
          <div><label htmlFor="dailyLimit" className="mb-1 block text-xs font-medium">Limite diário</label><input id="dailyLimit" name="dailyLimit" type="number" min={1} max={500} defaultValue={st.dailyLimit} disabled={!manage} className={`${inputClass} w-28`} /></div>
          <div><label htmlFor="boletoProvider" className="mb-1 block text-xs font-medium">Provedor de boleto</label>
            <select id="boletoProvider" name="boletoProvider" defaultValue={st.boletoProvider} disabled={!manage} className={`${inputClass} w-64`}>
              {BOLETO_PROVIDER_MODES.map((m) => { const off = (m === "cora_homologacao" && !stageOn) || (m === "cora_producao" && !prodOn); return <option key={m} value={m} disabled={off && st.boletoProvider !== m}>{MODE_LABEL[m]}{off ? " (desligado no servidor)" : ""}</option>; })}
            </select></div>
          <label className={`flex items-start gap-2 text-sm ${real ? "" : "text-muted-foreground"}`}><input type="hidden" name="autoSettleField" value="1" /><input type="checkbox" name="autoSettle" defaultChecked={st.autoSettle && real} disabled={!manage || !real} className="mt-0.5 size-4 accent-primary" /> <span>Baixa automática pela Cora<span className="block text-xs text-muted-foreground">Quando a Cora informar boleto pago e os valores conferirem, o pagamento é registrado sozinho (usuário “Cora (automático)”). Se algo não bater, fica para conferência manual.</span></span></label>
          {manage && prodOn && (
            <div className="basis-full rounded-md border border-negative/40 bg-negative-soft/40 p-3 text-xs">
              {prod ? (<>
                <label className="flex items-center gap-2"><input type="hidden" name="liveCanaryField" value="1" /><input type="checkbox" name="liveCanary" defaultChecked={st.liveCanary} className="size-4 accent-primary" /> Modo canário (no máximo {LIVE_CANARY_DAILY_MAX} boletos reais por dia)</label>
                <label htmlFor="liveConfirm" className="mt-2 block font-medium">Para <strong>desligar o canário</strong>, digite: {LIVE_CONFIRM_PHRASE}</label>
              </>) : <label htmlFor="liveConfirm" className="block font-medium">Para <strong>ligar a emissão REAL</strong> (escolha “{MODE_LABEL.cora_producao}” acima), digite: {LIVE_CONFIRM_PHRASE}</label>}
              <input id="liveConfirm" name="liveConfirm" autoComplete="off" spellCheck={false} placeholder={LIVE_CONFIRM_PHRASE} className={`${inputClass} mt-1 w-72`} />
              <p className="mt-1 text-muted-foreground">Fica registrado quem autorizou e quando. Entra sempre em modo canário.</p>
            </div>
          )}
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
                  <p className="text-xs text-muted-foreground">{KIND_LABEL[i.kind]}{i.kind === "boleto" && i.mode !== "simulado" ? ` (${MODE_LABEL[i.mode] ?? i.mode})` : ""} · vence {br(i.dueDate)} · {i.attempts} tentativa(s){i.lastError ? ` · ${i.lastError}` : ""}{i.externalRef ? ` · ref. ${i.externalRef}` : ""}{i.mode !== "simulado" && i.externalStatus === "pago" ? " · na Cora: PAGO (confira e dê a baixa)" : ""}</p>
                </div>
                <span className="flex items-center gap-3"><Money cents={i.amountCents} /><StatusPill tone={TONE[i.status]}>{i.status === "emitido" && i.mode !== "simulado" ? (i.mode === "cora_producao" ? "Emitido (Cora PRODUÇÃO)" : "Emitido (Cora de testes)") : STATUS_LABEL[i.status]}</StatusPill>
                  {request && i.status === "pendente" && <form action={cancelIssuanceAction}><input type="hidden" name="id" value={i.id} /><button className={buttonClass("ghost", "sm")}>Cancelar</button></form>}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
