import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getPanel, REGUA_KINDS, type Fn, type PanelRow } from "@/modules/authorizations/panel";
import { Callout, PageHeader, StatusPill } from "@/components/k3g/primitives";
import { SettingsTabs } from "@/components/k3g/settings-tabs";
import { SwitchForm } from "@/components/k3g/switch-form";
import { ConfirmForm } from "@/components/k3g/confirm-form";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { LIVE_CANARY_DAILY_MAX } from "@/modules/providers/registry";
import { canaryAction, saveLimitAction, toggleAction } from "./actions";

const when = (d: Date | null) => (d ? d.toLocaleString("pt-BR", { timeZone: "America/Manaus", dateStyle: "short", timeStyle: "short" }) : null);
const KIND_LABEL: Record<string, string> = { d_menos_3: "3 dias antes", d0: "No vencimento", d_mais_3: "3 dias depois", d_mais_7: "7 dias depois" };
const OK: Record<string, string> = {
  "boletos:ligado": "Boletos reais LIGADOS. Os boletos só nascem quando um lote aprovado tem a emissão solicitada e processada, e começam em modo cuidadoso.", "boletos:desligado": "Emissão de boletos PAUSADA: nada novo será emitido.", "boletos:salvo": "Modo dos boletos atualizado.",
  "email:ligado": "E-mail a clientes LIGADO.", "email:desligado": "E-mail a clientes DESLIGADO: nada mais sai.", "email:salvo": "Limite de e-mails salvo.",
  "sistema:ligado": "E-mail do sistema LIGADO (senha e convites).", "sistema:desligado": "E-mail do sistema DESLIGADO: senha e convites só por link manual.",
  "whatsapp:ligado": "WhatsApp LIGADO.", "whatsapp:desligado": "WhatsApp DESLIGADO (a régua também).", "whatsapp:salvo": "Limite de WhatsApp salvo.",
  "regua:ligado": "Régua automática LIGADA.", "regua:desligado": "Régua automática DESLIGADA.", "regua:salvo": "Réguas atualizadas.",
};

const COPY: Record<Fn, { title: string; what: string; on: string; off: string }> = {
  boletos: { title: "Boletos reais (Cora)", what: "Emitir boletos de verdade na Cora, que cobram o cliente.", on: "Ligado — emissão liberada", off: "Desligado — nada é emitido" },
  email: { title: "E-mail para clientes", what: "Enviar cobranças e lembretes (com o boleto e a nota fiscal) aos contatos financeiros dos clientes.", on: "Ligado — envia aos contatos financeiros", off: "Desligado — nenhum e-mail sai" },
  sistema: { title: "E-mail do sistema (senha e convites)", what: "Enviar a redefinição de senha («Esqueci minha senha») e os convites de acesso. Não envia cobrança e escreve a uma pessoa por vez. Independe do e-mail para clientes.", on: "Ligado — senha e convites por e-mail", off: "Desligado — só link manual" },
  whatsapp: { title: "WhatsApp para clientes", what: "Enviar cobranças por WhatsApp. Cada contato precisa ter dado consentimento.", on: "Ligado", off: "Desligado" },
  regua: { title: "Régua automática de WhatsApp", what: "Avisos automáticos antes e depois do vencimento, nos dias escolhidos.", on: "Ligada", off: "Desligada" },
};

export default async function Autorizacoes({ searchParams }: { searchParams: Promise<{ ok?: string; erro?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "billing.read")) return <Callout tone="warning">Seu papel não tem acesso ao painel de autorizações.</Callout>;
  const p = await getPanel(db, ctx.user.id, ctx.current.id);
  const order: Fn[] = ["boletos", "email", "sistema", "whatsapp", "regua"];

  return (
    <div className="space-y-5">
      <SettingsTabs role={role} current="autorizacoes" />
      <PageHeader title="Autorizações" description={`${ctx.current.name} · ligue ou desligue o que a plataforma pode fazer de verdade. Quem liga e quando fica no registro de atividades.`} />
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      <Callout tone="info">Só a diretoria liga ou desliga. Cada função também tem uma <strong>chave de emergência no servidor</strong>: se ela estiver desligada, a função não liga mesmo aqui. Desligar é sempre imediato.</Callout>

      <ul className="space-y-3">
        {order.map((fn) => {
          const r: PanelRow = p.rows[fn], c = COPY[fn];
          const disabled = !r.canChange || (!r.on && !!r.blocked);
          return (
            <li key={fn} className="rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">{c.title} <StatusPill tone={r.on ? (r.serverOff ? "warning" : "positive") : "neutral"}>{r.on ? (r.serverOff ? "Ligado aqui, mas PARADO pelo servidor" : c.on) : c.off}</StatusPill></p>
                  <p className="mt-1 text-sm text-muted-foreground">{c.what}</p>
                  {r.on && r.at && <p className="mt-1 text-xs text-muted-foreground">Ligado em {when(r.at)}</p>}
                  {r.on && r.serverOff && <p className="mt-1 text-sm font-medium text-warning-foreground">{r.blocked ?? "A chave de emergência do servidor está desligada."} Nada sai enquanto ela estiver desligada.</p>}
                  {r.blocked && !r.on && <p className="mt-1 text-sm font-medium text-warning-foreground">{r.blocked}</p>}
                  {!r.canChange && <p className="mt-1 text-xs text-muted-foreground">Seu papel só vê esta função; quem liga é a diretoria.</p>}
                </div>
                <SwitchForm action={toggleAction} label={`${c.title}: ${r.on ? "desligar" : "ligar"}`} on={r.on} disabled={disabled}
                  confirmMessage={fn === "boletos" && !r.on ? "Ligar os boletos REAIS? Eles são criados na Cora de produção e cobram o cliente de verdade. Começam em modo cuidadoso (poucos por dia)." : undefined}>
                  <input type="hidden" name="fn" value={fn} />
                  {fn === "regua" && !r.on && (r.detail.kinds as string[]).map((k) => <input key={k} type="hidden" name="kinds" value={k} />)}
                </SwitchForm>
              </div>

              {fn === "boletos" && r.detail.provider === "cora_producao" && (
                <ConfirmForm action={canaryAction} className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3 text-sm" message={r.detail.canary ? "Sair do modo cuidadoso? Deixa de valer o teto de 3 boletos por dia; vale só o limite diário da emissão." : undefined}>
                  <span>Modo cuidadoso: <strong>{r.detail.canary ? `no máximo ${LIVE_CANARY_DAILY_MAX} boletos por dia` : "sem esse teto (vale o limite diário da emissão)"}</strong></span>
                  <input type="hidden" name="canary" value={r.detail.canary ? "0" : "1"} />
                  {r.canChange && r.on && <button className={buttonClass("outline", "sm")}>{r.detail.canary ? "Sair do modo cuidadoso" : "Voltar ao modo cuidadoso"}</button>}
                </ConfirmForm>
              )}
              {(fn === "email" || fn === "whatsapp") && r.canChange && (
                <form action={saveLimitAction} className="mt-3 flex flex-wrap items-end gap-3 border-t border-border pt-3 text-sm">
                  <input type="hidden" name="fn" value={fn} />
                  <div><label htmlFor={`lim-${fn}`} className="mb-1 block text-xs font-medium">Limite por dia ({fn === "email" ? "1 a 200" : "1 a 10"})</label>
                    <input id={`lim-${fn}`} name={fn === "email" ? "dailyLimit" : "dailyCap"} type="number" min={1} max={fn === "email" ? 200 : 10} defaultValue={Number(fn === "email" ? r.detail.dailyLimit : r.detail.dailyCap)} className={`${inputClass} w-28`} /></div>
                  <button className={buttonClass("outline", "sm")} disabled={!r.on}>Salvar limite</button>
                  {fn === "email" && r.on && <span className="text-xs text-muted-foreground">Hoje: {Number(r.detail.sentToday)} enviado(s)</span>}
                  {!r.on && <span className="text-xs text-muted-foreground">Vale ao ligar: o limite acima.</span>}
                </form>
              )}
              {fn === "regua" && r.canChange && (
                <form action={saveLimitAction} className="mt-3 flex flex-wrap items-center gap-4 border-t border-border pt-3 text-sm">
                  <input type="hidden" name="fn" value="regua" />
                  {REGUA_KINDS.map((k) => <label key={k} className="flex items-center gap-2"><input type="checkbox" name="kinds" value={k} defaultChecked={(r.detail.kinds as string[]).includes(k)} /> {KIND_LABEL[k]}</label>)}
                  <button className={buttonClass("outline", "sm")} disabled={!r.on}>Salvar réguas</button>
                  {!r.on && <span className="text-xs text-muted-foreground">Ao ligar, vale a escolha salva (padrão: no vencimento).</span>}
                </form>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">Nota fiscal: segue <strong>junto do boleto</strong> no e-mail dos clientes marcados no contrato, assim que o PDF é anexado ao lote (Faturamento → Lotes). Não precisa de chave própria.</p>
    </div>
  );
}
