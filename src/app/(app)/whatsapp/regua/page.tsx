import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { REASON_LABEL } from "@/modules/whatsapp/outbound";
import { AUTO_KINDS, AUTO_LABEL, AUTO_PHRASE, getAutomation, reguaOverview, simulateRegua, type SimRow } from "@/modules/whatsapp/regua";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { AutomationForm } from "./form";
import { disableAutomationAction } from "../actions";

const OUT: Record<SimRow["outcome"], { tone: StatusTone; label: string }> = { sairia: { tone: "positive", label: "Sairia" }, espera: { tone: "warning", label: "Esperaria" }, nunca: { tone: "neutral", label: "Não sairia" }, ja_tratada: { tone: "info", label: "Já tratada" } };
const OK: Record<string, string> = { salvo: "Régua automática ligada. Ela só começa a valer a partir de amanhã.", desligada: "Régua automática desligada. O que estava na fila automática foi suprimido." };
const br = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const Tile = ({ n, label }: { n: number | string; label: string }) => <div className="rounded-lg border p-3"><div className="text-xl font-semibold tabular-nums">{n}</div><div className="text-xs text-muted-foreground">{label}</div></div>;

export default async function Regua({ searchParams }: { searchParams: Promise<{ ok?: string; erro?: string; dia?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.history")) return <Callout tone="warning">Seu papel não tem acesso à régua do WhatsApp.</Callout>;
  const authorize = can(role, "whatsapp.authorize"), send = can(role, "whatsapp.send");
  const [auto, ov] = await Promise.all([getAutomation(db, ctx.user.id, ctx.current.id), reguaOverview(db, ctx.user.id, ctx.current.id, 30)]);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(sp.dia ?? "") ? sp.dia : undefined;
  const sim = send ? await simulateRegua(db, ctx.user.id, ctx.current.id, { day: dia }) : null;
  const t = ov.totals;
  return (
    <div className="space-y-5">
      <PageHeader title="Régua e painel do WhatsApp" description={`${ctx.current.name} · lembretes automáticos (desligados por padrão), simulação e números dos últimos 30 dias.`} actions={<><AppLink href="/whatsapp/historico" className={buttonClass("outline")}>Histórico</AppLink><AppLink href="/whatsapp/configuracao" className={buttonClass("outline")}>Configuração</AppLink></>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      <Callout tone="warning">A WAHA <strong>não é um canal oficial</strong> do WhatsApp: o número pode ser restringido. A régua nunca sai sem consentimento, respeita o pedido de parar e a cobrança ainda devida, e <strong>no máximo 1 aviso por cliente a cada 7 dias</strong>. Comece com uma régua só.</Callout>

      <SectionCard title="Situação" action={auto.enabled && auto.serverOn && ov.status.actorOk !== false ? <StatusPill tone="warning">Ligada</StatusPill> : <StatusPill tone="neutral">{auto.enabled ? "Ligada, mas parada" : "Desligada"}</StatusPill>}>
        <ul className="space-y-1 text-sm">
          <li>Chave de automação do servidor: <strong>{auto.serverOn ? "ligada" : "desligada"}</strong>{!auto.serverOn && <span className="text-muted-foreground"> (nada sai sozinho; ligar é decisão operacional)</span>}</li>
          <li>Cobrança por WhatsApp da empresa: <strong>{auto.sendEnabled ? "liberada" : "desligada"}</strong></li>
          <li>Régua da empresa: <strong>{auto.enabled ? "ligada" : "desligada"}</strong>{auto.enabled && <> · réguas: {auto.kinds.map((k) => AUTO_LABEL[k]).join(", ")}</>}</li>
          {auto.enabled && <li>Aprovação: {auto.reference} · desde {auto.authorizedAt?.toLocaleDateString("pt-BR", { timeZone: "America/Manaus" })}</li>}
          {ov.status.actorOk === false && <li className="text-negative-foreground">A pessoa que ligou a régua não tem mais permissão: ela está <strong>parada</strong>. Desligue e ligue de novo com outra pessoa da diretoria.</li>}
          <li>Conexão: <strong>{ov.status.connected ? "conectada" : "sem conexão conectada"}</strong></li>
        </ul>
        {authorize && (auto.enabled
          ? <form action={disableAutomationAction} className="mt-3"><button className={buttonClass("danger", "sm")}>Desligar régua automática</button></form>
          : auto.sendEnabled ? <div className="mt-4"><AutomationForm phrase={AUTO_PHRASE} kinds={AUTO_KINDS.map((k) => ({ key: k, label: AUTO_LABEL[k] }))} /></div> : <p className="mt-3 text-sm text-muted-foreground">Antes, libere a cobrança por WhatsApp em Configuração.</p>)}
        {!authorize && !auto.enabled && <p className="mt-3 text-sm text-muted-foreground">Peça à diretoria para ligar.</p>}
      </SectionCard>

      <SectionCard title="Números dos últimos 30 dias">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile n={t.sent} label="Enviadas" /><Tile n={t.delivered} label="Entregues" /><Tile n={t.read} label="Lidas" /><Tile n={t.queued} label="Na fila" />
          <Tile n={t.failed} label="Falharam" /><Tile n={t.unknown} label="Sem confirmação" /><Tile n={t.suppressed} label="Suprimidas" /><Tile n={ov.optOuts} label="Pediram para parar" />
          <Tile n={ov.replies.total} label="Respostas de clientes" /><Tile n={ov.replies.open} label="Respostas em aberto" /><Tile n={ov.replies.disputes} label="Contestações" /><Tile n={t.byOrigin.regua} label="Criadas pela régua" />
        </div>
        {ov.suppressedBy.length > 0 && <div className="mt-3 text-sm"><div className="font-medium">Por que foram suprimidas</div><ul className="mt-1 text-muted-foreground">{ov.suppressedBy.map((s) => <li key={s.reason}>{s.n} · {REASON_LABEL[s.reason] ?? s.reason}</li>)}</ul></div>}
        <p className="mt-3 text-sm">Cobranças <strong>pagas até 7 dias depois de um aviso enviado</strong>: {ov.paidAfterNotice.charges} ({formatBRL(ov.paidAfterNotice.cents)}). <span className="text-muted-foreground">É só uma coincidência de datas: o painel <strong>não</strong> afirma que o aviso causou o pagamento (o cliente pode ter pago pelo boleto, e-mail ou telefone).</span></p>
      </SectionCard>

      {sim && (
        <SectionCard title={`Simulação do dia ${br(sim.day)} (não envia nada)`}>
          <form className="mb-3 flex flex-wrap items-end gap-2" method="get">
            <div><label htmlFor="rg-dia" className="mb-1 block text-xs text-muted-foreground">Dia</label><input id="rg-dia" type="date" name="dia" defaultValue={sim.day} className={inputClass} /></div>
            <button className={buttonClass("outline", "sm")}>Simular</button>
          </form>
          {sim.note && <Callout tone="info">{sim.note}</Callout>}
          {sim.rows.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma cobrança em aberto cai em D-3, D0, D+3 ou D+7 neste dia.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground"><th className="pb-2 pr-4 font-medium">Cliente</th><th className="pb-2 pr-4 font-medium">Marco</th><th className="pb-2 pr-4 font-medium">Resultado</th><th className="pb-2 font-medium">Régua ligada?</th></tr></thead>
              <tbody>{sim.rows.map((r) => (
                <tr key={`${r.chargeId}${r.kind}`} className="border-t align-top">
                  <td className="py-2 pr-4">{r.customer}<div className="text-xs text-muted-foreground">venc. {br(r.due)}</div></td>
                  <td className="py-2 pr-4">{AUTO_LABEL[r.kind]}</td>
                  <td className="py-2 pr-4"><StatusPill tone={OUT[r.outcome].tone}>{OUT[r.outcome].label}</StatusPill>{r.why && <div className="mt-1 text-xs text-muted-foreground">{r.why}</div>}</td>
                  <td className="py-2 text-muted-foreground">{r.armed ? "Sim" : "Não"}</td>
                </tr>))}</tbody></table></div>
          )}
          {sim.truncated && <p className="mt-2 text-xs text-muted-foreground">Mostrando as primeiras 200.</p>}
          <p className="mt-3 text-xs text-muted-foreground">A régua só age <strong>no dia do marco</strong> (não recupera dia perdido), só a partir do dia seguinte ao de ligar, e cada cobrança é tentada <strong>uma vez</strong> por marco. «Esperaria» = janela, limite ou conexão; «Não sairia» = sem consentimento, pediu para parar, paga, aviso recente…</p>
        </SectionCard>
      )}
    </div>
  );
}
