import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getSettings } from "@/modules/messaging/service";
import { WINDOW_REASON, windowState } from "@/modules/messaging/window";
import { holidays } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { saveSettingsAction } from "../actions";

const DIAS = [["1", "Seg"], ["2", "Ter"], ["3", "Qua"], ["4", "Qui"], ["5", "Sex"], ["6", "Sáb"], ["0", "Dom"]] as const;
const check = "size-4 rounded border-input accent-primary";

export default async function ConfiguracaoMensagens({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "messages.read")) return <Callout tone="warning">Seu papel não tem acesso à configuração de mensagens.</Callout>;
  const st = await getSettings(db, ctx.user.id, ctx.current.id);
  const manage = can(role, "messages.templates");
  const hol = await db.select().from(holidays).where(eq(holidays.companyId, ctx.current.id));
  const w = windowState(new Date(), st, new Map(hol.map((h) => [h.day, h.name])));

  return (
    <div className="space-y-5">
      <PageHeader title="Configuração de envio" description={`${ctx.current.name} · janela, limites e chave geral.`}
        actions={<AppLink href="/mensagens" className={buttonClass("outline")}>Fila</AppLink>} />
      <Callout tone="info">Simulação: o agendador processa a fila nas regras abaixo, mas <strong>nenhuma mensagem real é enviada</strong>. Os provedores reais só entram com credenciais, homologação e autorização.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok === "salvo" && <Callout tone="positive" role="status">Configuração salva.</Callout>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Agora:</span>
        {st.paused ? <StatusPill tone="negative">Envio pausado</StatusPill> : w.open ? <StatusPill tone="positive">Dentro da janela</StatusPill> : <StatusPill tone="warning">{WINDOW_REASON[w.reason]}</StatusPill>}
        <StatusPill tone={st.autoDispatch ? "info" : "neutral"}>{st.autoDispatch ? "Envio automático ligado" : "Envio automático desligado"}</StatusPill>
      </div>

      <form action={saveSettingsAction} className="space-y-5">
        <SectionCard title="Chaves">
          <div className="space-y-3 text-sm">
            <label className="flex items-start gap-2"><input type="checkbox" name="paused" defaultChecked={st.paused} disabled={!manage} className={check} /><span><strong>Pausar tudo</strong> — nada é processado, nem manual nem automático (chave de emergência).</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" name="autoDispatch" defaultChecked={st.autoDispatch} disabled={!manage} className={check} /><span><strong>Envio automático</strong> — o agendador processa a fila sozinho, dentro da janela.</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" name="emailEnabled" defaultChecked={st.emailEnabled} disabled={!manage} className={check} /><span>Canal <strong>e-mail</strong> ligado</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" name="whatsappEnabled" defaultChecked={st.whatsappEnabled} disabled={!manage} className={check} /><span>Canal <strong>WhatsApp</strong> ligado — vem desligado por segurança (WAHA não é oficial e a conta pode ser bloqueada).</span></label>
          </div>
        </SectionCard>

        <SectionCard title="Janela de envio (horário de Manaus)">
          <div className="grid max-w-md grid-cols-2 gap-4">
            <div><label htmlFor="windowStart" className="mb-1 block text-sm font-medium">Início</label><input id="windowStart" name="windowStart" type="time" defaultValue={st.windowStart} required disabled={!manage} className={inputClass} /></div>
            <div><label htmlFor="windowEnd" className="mb-1 block text-sm font-medium">Fim</label><input id="windowEnd" name="windowEnd" type="time" defaultValue={st.windowEnd} required disabled={!manage} className={inputClass} /></div>
          </div>
          <fieldset className="mt-4"><legend className="mb-1 text-sm font-medium">Dias permitidos</legend>
            <div className="flex flex-wrap gap-3 text-sm">{DIAS.map(([v, l]) => <label key={v} className="flex items-center gap-1.5"><input type="checkbox" name="weekdays" value={v} defaultChecked={st.weekdays.includes(Number(v))} disabled={!manage} className={check} />{l}</label>)}</div>
          </fieldset>
          <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" name="skipHolidays" defaultChecked={st.skipHolidays} disabled={!manage} className={check} />Não enviar em feriados (nacionais e os cadastrados em Faturamento)</label>
        </SectionCard>

        <SectionCard title="Limites">
          <div className="grid max-w-xl gap-4 sm:grid-cols-3">
            <div><label htmlFor="maxPerRun" className="mb-1 block text-sm font-medium">Por execução</label><input id="maxPerRun" name="maxPerRun" type="number" min={1} max={500} defaultValue={st.maxPerRun} required disabled={!manage} className={inputClass} /></div>
            <div><label htmlFor="maxPerHour" className="mb-1 block text-sm font-medium">Por hora</label><input id="maxPerHour" name="maxPerHour" type="number" min={1} max={2000} defaultValue={st.maxPerHour} required disabled={!manage} className={inputClass} /></div>
            <div><label htmlFor="maxLateDays" className="mb-1 block text-sm font-medium">Tolerância (dias)</label><input id="maxLateDays" name="maxLateDays" type="number" min={0} max={30} defaultValue={st.maxLateDays} required disabled={!manage} className={inputClass} /></div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Mensagem com mais dias de atraso que a tolerância não sai: vai para revisão manual (um lembrete D-3 enviado depois do vencimento não faz sentido).</p>
        </SectionCard>
        {manage ? <button className={buttonClass("primary")}>Salvar configuração</button> : <p className="text-sm text-muted-foreground">Somente diretoria e gerente alteram a configuração.</p>}
      </form>
    </div>
  );
}
