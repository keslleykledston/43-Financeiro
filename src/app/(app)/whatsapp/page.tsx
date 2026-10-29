import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listBindings, listSessions, moduleOn, sendOn } from "@/modules/whatsapp/service";
import { STATUS_LABEL, type SessionStatus } from "@/modules/whatsapp/domain";
import { wahaConfigured } from "@/modules/providers/waha";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { CreateForm } from "./create-form";
import { SessionLive } from "./session-live";
import { bindCompanyAction, disconnectSessionAction, pauseSessionAction, resumeSessionAction, startSessionAction, unbindCompanyAction } from "./actions";

const TONE: Record<SessionStatus, StatusTone> = { CREATED: "neutral", STARTING: "info", QR_REQUIRED: "warning", CONNECTED: "positive", DISCONNECTED: "neutral", DEGRADED: "negative", REVOKED: "neutral" };
const OK_MSG: Record<string, string> = { iniciada: "Conexão iniciada.", pausada: "Conexão pausada: nenhum envio sai por ela.", liberada: "Conexão liberada para envios (continuam valendo todas as travas).", desconectada: "Número desconectado.", vinculada: "Empresa vinculada à conexão. Ela precisa registrar a própria autorização de envio e os consentimentos.", desvinculada: "Esta empresa deixou de usar a conexão." };

export default async function WhatsApp({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.read")) return <Callout tone="warning">Seu papel não tem acesso ao WhatsApp.</Callout>;
  const manage = can(role, "whatsapp.manage");
  const moduleActive = moduleOn() && wahaConfigured();
  const sessions = await listSessions(db, ctx.user.id, ctx.current.id);
  const authorize = can(role, "whatsapp.authorize");
  const bindings = new Map(await Promise.all(sessions.map(async (s) => [s.id, await listBindings(db, ctx.user.id, ctx.current!.id, s.id)] as const)));
  const dirOf = ctx.companies.filter((c) => can(c.role, "whatsapp.authorize")); // empresas onde o usuário é diretoria (candidatas a entrar)

  return (
    <div className="space-y-5">
      <PageHeader title="WhatsApp" description={`${ctx.current.name} · conexões e envio de teste.`}
        actions={<>{can(role, "whatsapp.history") && <AppLink href="/whatsapp/entrada" className={buttonClass("outline")}>Caixa de entrada</AppLink>}{can(role, "whatsapp.history") && <AppLink href="/whatsapp/historico" className={buttonClass("outline")}>Histórico</AppLink>}<AppLink href="/whatsapp/configuracao" className={buttonClass("outline")}>Configuração</AppLink>{can(role, "whatsapp.consent") && <AppLink href="/whatsapp/consentimentos" className={buttonClass("outline")}>Consentimentos</AppLink>}{can(role, "whatsapp.send") && <AppLink href="/whatsapp/teste" className={buttonClass("outline")}>Enviar teste</AppLink>}</>} />
      <Callout tone="warning">A WAHA <strong>não é um canal oficial</strong> do WhatsApp: ela pode desconectar ou ser restringida, e os limites do sistema <strong>não eliminam esse risco</strong>. Mantenha outro canal para o que for crítico.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK_MSG[sp.ok] && <Callout tone="positive" role="status">{OK_MSG[sp.ok]}</Callout>}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Servidor:</span>
        <StatusPill tone={moduleActive ? "positive" : "warning"}>{moduleActive ? "Módulo ligado" : "Módulo desligado"}</StatusPill>
        <StatusPill tone={sendOn() ? "warning" : "neutral"}>{sendOn() ? "Envio de teste liberado" : "Envio desligado (nada sai)"}</StatusPill>
        <StatusPill tone="neutral">Automações desligadas</StatusPill>
      </div>
      {!moduleActive && <Callout tone="info">O módulo está desligado no servidor ou a WAHA não está configurada. As conexões abaixo ficam só para consulta.</Callout>}

      <div className="grid gap-4 lg:grid-cols-2">
        {sessions.length === 0 && <SectionCard><p className="text-sm text-muted-foreground">Nenhuma conexão ainda. {manage && moduleActive ? "Crie a primeira ao lado." : ""}</p></SectionCard>}
        {sessions.map((s) => (
          <SectionCard key={s.id} title={s.displayName} action={<StatusPill tone={TONE[s.status]}>{STATUS_LABEL[s.status]}</StatusPill>}>
            <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Número</dt><dd>{s.phoneMasked ?? "—"}</dd>
              <dt className="text-muted-foreground">Remetente</dt><dd>{s.senderIdentity}</dd>
              <dt className="text-muted-foreground">Empresas</dt><dd>{s.companiesBound}</dd>
              <dt className="text-muted-foreground">Envios</dt><dd>{s.paused ? <StatusPill tone="warning">Pausada</StatusPill> : <StatusPill tone="positive">Liberada</StatusPill>}</dd>
              <dt className="text-muted-foreground">Última leitura</dt><dd>{s.lastSeenAt ? s.lastSeenAt.toLocaleString("pt-BR", { timeZone: "America/Manaus" }) : "—"}</dd>
            </dl>
            <SessionLive id={s.id} initial={s.status} label={STATUS_LABEL[s.status]} canSeeQr={manage} />
            <div className="mt-4 border-t pt-3">
              <h3 className="mb-2 text-sm font-medium">Empresas que usam esta conexão</h3>
              <ul className="space-y-1 text-sm">
                {bindings.get(s.id)!.map((b) => <li key={b.name + b.since.toISOString()} className="flex flex-wrap items-center gap-x-2"><span className={b.current ? "font-medium" : ""}>{b.name}</span>{b.identity && <span className="text-muted-foreground">· remetente «{b.identity}»</span>}{b.current && <StatusPill tone="info">esta empresa</StatusPill>}</li>)}
              </ul>
              {authorize && (() => {
                const bound = new Set(bindings.get(s.id)!.map((b) => b.companyId));
                const free = dirOf.filter((c) => !bound.has(c.id));
                return (
                  <div className="mt-3 space-y-3">
                    {free.length > 0 && (
                      <form action={bindCompanyAction} className="grid gap-2 sm:grid-cols-2">
                        <input type="hidden" name="id" value={s.id} />
                        <div><label htmlFor={`bt-${s.id}`} className="mb-1 block text-xs font-medium">Vincular outra empresa</label><select id={`bt-${s.id}`} name="targetCompanyId" required className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm">{free.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                        <div><label htmlFor={`bi-${s.id}`} className="mb-1 block text-xs font-medium">Como o cliente vê quem escreve</label><input id={`bi-${s.id}`} name="senderIdentity" required minLength={3} maxLength={80} placeholder="Ex.: Financeiro K3G Call" className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm" /></div>
                        <label className="flex items-start gap-2 text-xs sm:col-span-2"><input type="checkbox" name="confirm" required className="mt-0.5 size-3.5 accent-primary" /><span>Confirmo que a diretoria das <strong>duas</strong> empresas autoriza o uso compartilhado deste número. Os limites diários e o risco de restrição passam a ser divididos.</span></label>
                        <div className="sm:col-span-2"><button className={buttonClass("outline", "sm")}>Vincular empresa</button></div>
                      </form>
                    )}
                    {bindings.get(s.id)!.length > 1 && (
                      <form action={unbindCompanyAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="id" value={s.id} />
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" name="confirm" required className="size-3.5 accent-primary" />Confirmo</label>
                        <button className={buttonClass("danger", "sm")}>Tirar {ctx.current!.name} desta conexão</button>
                      </form>
                    )}
                  </div>
                );
              })()}
            </div>
            {manage && s.companiesBound > 1 && <p className="mt-4 text-xs text-warning-foreground">Esta conexão é compartilhada: pausar ou desconectar vale para <strong>todas</strong> as empresas que a usam.</p>}
            {manage && (
              <div className="mt-2 flex flex-wrap gap-2">
                {(s.status === "DISCONNECTED" || s.status === "CREATED" || s.status === "DEGRADED") && <form action={startSessionAction}><input type="hidden" name="id" value={s.id} /><button className={buttonClass("primary", "sm")}>{s.status === "DEGRADED" ? "Tentar de novo" : "Iniciar / conectar"}</button></form>}
                {s.paused
                  ? <form action={resumeSessionAction}><input type="hidden" name="id" value={s.id} /><button className={buttonClass("outline", "sm")} disabled={s.status !== "CONNECTED"}>Liberar envios</button></form>
                  : <form action={pauseSessionAction}><input type="hidden" name="id" value={s.id} /><button className={buttonClass("outline", "sm")}>Pausar envios</button></form>}
                <form action={disconnectSessionAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="id" value={s.id} />
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" name="confirm" required className="size-3.5 accent-primary" />Confirmo</label>
                  <button className={buttonClass("danger", "sm")}>Desconectar número</button>
                </form>
              </div>
            )}
          </SectionCard>
        ))}
        {manage && moduleActive && (
          <SectionCard title="Nova conexão">
            <CreateForm defaultIdentity={`Financeiro ${ctx.current.name}`} />
          </SectionCard>
        )}
      </div>
    </div>
  );
}
