import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCustomerMode } from "@/modules/crm/service";
import { getConnection, listConflicts, listRuns } from "@/modules/integrations/crm/sync";
import { ConnectionForm } from "./connection-form";
import { ModeForm } from "./mode-form";
import { CutoverForm, QueueUnlinkedForm, RetryPushesForm } from "./cutover-panel";
import { cutoverView, FRESH_SYNC_MS } from "@/modules/integrations/crm/cutover";
import { SyncPanel } from "./sync-panel";
import { resolveAction } from "./actions";
import { PROVIDER_CATALOG, unsupportedFlagsOn } from "@/modules/providers/registry";
import { readiness } from "@/modules/providers/readiness";
import { getCoraStatus, hasCoraCredentials } from "@/modules/providers/cora-config";
import { CORA_SCOPE, ENV_LABEL } from "@/modules/providers/cora";
import { CoraForm } from "./cora-form";
import { CertificateForm, CertificateVerify } from "./certificate-form";
import { getCertificateStatus, hasNfseCertificate } from "@/modules/nfse/certificate";
import { EmailForm } from "./email-form";
import { AuthorizeForm, SmtpTestForm, TestForm } from "./email-live-forms";
import { getEmailLiveStatus } from "@/modules/providers/email-auth";
import { listSendLog } from "@/modules/providers/email-live";
import { getEmailStatus, hasEmailAccount } from "@/modules/providers/email-config";
import { SECURITY_LABEL } from "@/modules/providers/email";
import { nfseProfileComplete } from "@/modules/companies/fiscal";
import { disableWebhookAction, enableWebhookAction, removeCertificateAction, removeCoraAction, removeEmailAction, revokeEmailLiveAction } from "./actions";
import { webhookStatus } from "@/modules/issuance/webhooks";

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
  const coraAccess = can(role, "providers.credentials");
  const cora = coraAccess ? await getCoraStatus(db, ctx.user.id, ctx.current.id) : [];
  const hooks = coraAccess ? await webhookStatus(db, ctx.user.id, ctx.current.id) : [];
  const cert = coraAccess ? await getCertificateStatus(db, ctx.user.id, ctx.current.id) : null;
  const certInDb = coraAccess ? await hasNfseCertificate(db, ctx.user.id, ctx.current.id) : false;
  const coraInDb = coraAccess ? await hasCoraCredentials(db, ctx.user.id, ctx.current.id) : false;
  const email = coraAccess ? await getEmailStatus(db, ctx.user.id, ctx.current.id) : null;
  const live = coraAccess ? await getEmailLiveStatus(db, ctx.user.id, ctx.current.id) : null;
  const sendLog = coraAccess ? await listSendLog(db, ctx.user.id, ctx.current.id, 8) : [];
  const emailInDb = coraAccess ? await hasEmailAccount(db, ctx.user.id, ctx.current.id) : false;
  const fiscalComplete = can(role, "company.manage") ? await nfseProfileComplete(db, ctx.user.id, ctx.current.id) : false;
  const cut = await cutoverView(db, ctx.user.id, ctx.current.id);
  const staleSync = !cut.lastSyncAt || Date.now() - cut.lastSyncAt.getTime() > FRESH_SYNC_MS;
  const master = process.env.CRM_SYNC_ENABLED === "true";
  const configured = !!process.env.CRM_BASE_URL && !!process.env.CRM_API_TOKEN;
  return (
    <div className="max-w-3xl space-y-5">
      <div><h1 className="text-2xl font-semibold">Integrações</h1><p className="text-sm text-muted-foreground">{ctx.current.name}</p></div>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-1 font-semibold">Origem dos clientes</h2>
        <p className="mb-3 text-sm text-muted-foreground">Escolha, para esta empresa, onde os clientes são mantidos. Atual: <strong>{mode === "crm" ? "CRM" : "Local"}</strong>.</p>
        {cut.done ? <p className="text-sm text-muted-foreground">Corte do CRM feito em <strong>{fmt(cut.at!)}</strong>: o K3G Finance é a fonte dos clientes e não lê mais o CRM. Esta escolha não volta ao CRM.</p> : <ModeForm mode={mode} canChange={manage} />}
      </section>
      {cut.done && (
        <section className="rounded-lg border bg-card p-5" aria-labelledby="envio-h">
          <h2 id="envio-h" className="mb-1 font-semibold">Envio ao CRM</h2>
          <p className="mb-3 text-sm text-muted-foreground">O K3G Finance decide a situação dos clientes (ativo, suspenso, cancelado) e cria o cliente novo; isso é enviado ao CRM por esta fila. Se o CRM estiver fora do ar, nada se perde: o envio tenta de novo.</p>
          <ul className="mb-3 space-y-1 text-sm">
            <li>Envio ligado neste servidor: <strong>{cut.writeback.enabled ? "sim" : "não"}</strong> · token de escrita: <strong>{cut.writeback.hasWriteToken ? "configurado" : "falta"}</strong> · rota de criação de cliente: <strong>{cut.writeback.createPath ? "informada" : "falta (a criação espera a equipe do CRM)"}</strong></li>
            <li>Na fila: <strong>{cut.outbox.pendente}</strong> · falharam: <strong>{cut.outbox.falhou}</strong> · enviados: <strong>{cut.outbox.enviado}</strong></li>
            <li>Clientes com cadastro no CRM: <strong>{cut.linked}</strong> · sem cadastro lá: <strong>{cut.unlinked}</strong></li>
          </ul>
          {!(cut.writeback.enabled && cut.writeback.hasWriteToken) && <p role="note" className="mb-3 rounded-md bg-warning-soft p-3 text-sm text-warning-foreground">O envio ainda não está ligado neste servidor: as mudanças ficam <strong>aguardando na fila</strong> e saem quando a equipe do CRM liberar o acesso de escrita (ver docs/CORTE_CRM.md).</p>}
          {cut.open.length > 0 && (
            <ul className="mb-3 divide-y divide-border text-sm">
              {cut.open.map((o) => <li key={o.id} className="flex flex-wrap justify-between gap-2 py-2"><span className="min-w-0 truncate">{o.name} — {o.kind === "create" ? "criar no CRM" : `situação → ${o.desiredStatus}`}</span><span className={o.state === "falhou" ? "text-negative-foreground" : "text-muted-foreground"}>{o.state === "falhou" ? "falhou" : "na fila"}{o.lastError ? ` · ${o.lastError}` : ""}</span></li>)}
            </ul>
          )}
          {manage && <div className="flex flex-wrap gap-3"><RetryPushesForm failed={cut.outbox.falhou} /><QueueUnlinkedForm count={cut.unlinked} /></div>}
        </section>
      )}
      {!cut.done && mode === "crm" && manage && (
        <section className="rounded-lg border bg-card p-5" aria-labelledby="corte-h">
          <h2 id="corte-h" className="mb-1 font-semibold">Corte do CRM</h2>
          <p className="mb-3 text-sm text-muted-foreground">Hoje o CRM é a fonte dos clientes e o K3G Finance só lê. O <strong>corte</strong> inverte isso: o K3G Finance passa a ser a fonte da verdade (cadastro, contratos e situação), <strong>para de ler o CRM</strong> e passa a enviar ao CRM a situação do cliente e os clientes novos. É feito uma vez e não volta.</p>
          <ul className="mb-3 space-y-1 text-sm">
            <li>{cut.openConflicts === 0 ? "✔" : "✖"} Conflitos de sincronização em aberto: <strong>{cut.openConflicts}</strong></li>
            <li>{staleSync ? "⚠" : "✔"} Última sincronização: <strong>{cut.lastSyncAt ? fmt(cut.lastSyncAt) : "nunca"}</strong>{staleSync && " — sincronize de novo antes, para trazer o que mudou no CRM"}</li>
            <li>Clientes já vindos do CRM: <strong>{cut.linked}</strong></li>
          </ul>
          <CutoverForm stale={staleSync} blocked={cut.openConflicts > 0 ? "Resolva os conflitos abaixo antes do corte." : null} />
        </section>
      )}
      {mode === "local" ? (cut.done ? null :
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
      <section className="rounded-lg border bg-card p-5" aria-labelledby="cora-h">
        <h2 id="cora-h" className="mb-1 font-semibold">Cora — boletos</h2>
        <p className="mb-3 text-sm text-muted-foreground">Integração <strong>somente de boletos</strong>. A plataforma não movimenta dinheiro da conta.</p>
        <div className="mb-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><p className="mb-1 font-medium">Pode</p><ul className="list-disc pl-5 text-muted-foreground">{CORA_SCOPE.allowed.map((a) => <li key={a.key}>{a.label}</li>)}</ul></div>
          <div><p className="mb-1 font-medium">Nunca faz</p><ul className="list-disc pl-5 text-muted-foreground">{CORA_SCOPE.forbidden.map((a) => <li key={a.key}>{a.label}</li>)}</ul></div>
        </div>
        {coraAccess ? (<>
          <ul className="mb-4 divide-y divide-border text-sm">
            {cora.map((c) => (
              <li key={c.environment} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div><p className="font-medium">{ENV_LABEL[c.environment]}</p>
                  <p className="text-xs text-muted-foreground">{c.configured ? <>Configurado{c.label ? ` · ${c.label}` : ""} · certificado {c.fingerprint}… · vence em {c.notAfter!.split("-").reverse().join("/")}{c.daysLeft! < 0 ? " (VENCIDO)" : c.daysLeft! <= 30 ? ` (faltam ${c.daysLeft} dias)` : ""}</> : "Nenhuma credencial guardada"}</p></div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${c.configured ? (c.daysLeft! < 0 ? "bg-negative-soft text-negative-foreground" : "bg-positive-soft text-positive-foreground") : "bg-muted"}`}>{c.configured ? (c.daysLeft! < 0 ? "Vencido" : "Guardada") : "Pendente"}</span>
                  {c.configured && <form action={removeCoraAction}><input type="hidden" name="environment" value={c.environment} /><button className="rounded-md px-2.5 py-1 text-xs text-negative-foreground ring-1 ring-border">Remover</button></form>}
                </div>
              </li>
            ))}
          </ul>
          {hooks.map((h) => (
            <div key={h.environment} className="mb-4 rounded-md border p-3 text-sm">
              <p className="font-medium">Avisos de pagamento (webhook) — {ENV_LABEL[h.environment]}</p>
              <p className="mt-1 text-xs text-muted-foreground">A Cora avisa quando um boleto é <strong>pago</strong> ou <strong>cancelado</strong>. O aviso não vale por si só: a plataforma <strong>reconsulta o boleto na Cora</strong> antes de qualquer coisa. Não movimenta dinheiro.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${h.active ? "bg-positive-soft text-positive-foreground" : "bg-muted"}`}>{h.active ? `Ativo (${h.triggers} aviso(s) cadastrados)` : "Desativado"}</span>
                {h.pending > 0 && <span className="text-xs text-muted-foreground">{h.pending} aviso(s) na fila</span>}
                {cora.find((c) => c.environment === h.environment)?.configured && (
                  <form action={enableWebhookAction}><input type="hidden" name="environment" value={h.environment} /><button className="rounded-md px-2.5 py-1 text-xs ring-1 ring-border">{h.active ? "Girar segredo (recadastrar)" : "Ativar avisos"}</button></form>)}
                {h.active && <form action={disableWebhookAction}><input type="hidden" name="environment" value={h.environment} /><button className="rounded-md px-2.5 py-1 text-xs text-negative-foreground ring-1 ring-border">Desativar</button></form>}
              </div>
            </div>
          ))}
          <p className="mb-3 rounded-md bg-muted p-3 text-xs text-muted-foreground">Guardar as credenciais <strong>não liga a emissão real</strong>. Ela continua desligada até a homologação e a sua autorização escrita (veja o checklist abaixo). Na Cora, crie a integração direta só com o que é preciso para boletos.</p>
          <CoraForm />
        </>) : <p className="text-sm text-muted-foreground">As credenciais da Cora são cadastradas somente pela diretoria.</p>}
      </section>
      <section className="rounded-lg border bg-card p-5" aria-labelledby="nfse-cert-h">
        <h2 id="nfse-cert-h" className="mb-1 font-semibold">Certificado digital A1 — NFS-e (Padrão Nacional)</h2>
        <p className="mb-3 text-sm text-muted-foreground">O certificado <strong>e-CNPJ A1</strong> (arquivo .pfx) da empresa assina a nota fiscal de serviço. Importar aqui <strong>não emite nota nem liga nada</strong>: a emissão real depende da homologação e da sua autorização escrita. O sistema confere senha, validade e CNPJ, mas <strong>não valida a cadeia ICP-Brasil</strong>: quem decide se o certificado vale é a Receita, no teste de homologação.</p>
        {coraAccess && cert ? (<>
          {cert.active ? (
            <div className="mb-4 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="font-medium">{cert.active.subject}</p>
                  <p className="text-xs text-muted-foreground">CNPJ {cert.active.holderCnpj} · emitido por {cert.active.issuer} · impressão digital {cert.active.fingerprint}… · vence em {cert.active.notAfter.split("-").reverse().join("/")}{cert.active.daysLeft < 0 ? " (VENCIDO)" : cert.active.daysLeft <= 30 ? ` (faltam ${cert.active.daysLeft} dias)` : ""}</p></div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cert.active.daysLeft < 0 ? "bg-negative-soft text-negative-foreground" : cert.active.daysLeft <= 30 ? "bg-warning-soft text-warning-foreground" : "bg-positive-soft text-positive-foreground"}`}>{cert.active.daysLeft < 0 ? "Vencido" : cert.active.daysLeft <= 30 ? "Vence em breve" : "Guardado"}</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3"><CertificateVerify />
                <form action={removeCertificateAction}><button className="rounded-md px-2.5 py-1 text-xs text-negative-foreground ring-1 ring-border">Remover (apaga o certificado e a chave)</button></form></div>
            </div>
          ) : <p className="mb-4 rounded-md bg-muted p-3 text-sm text-muted-foreground">Nenhum certificado guardado para esta empresa.</p>}
          {cert.history.length > 0 && <p className="mb-3 text-xs text-muted-foreground">Histórico: {cert.history.map((h) => `${h.status === "substituido" ? "substituído" : "removido"} (vencia ${h.notAfter.split("-").reverse().join("/")}, ${h.fingerprint}…)`).join(" · ")}. Os segredos dos antigos foram apagados.</p>}
          <CertificateForm replace={!!cert.active} />
        </>) : <p className="text-sm text-muted-foreground">O certificado digital é importado somente pela diretoria.</p>}
      </section>
      <section className="rounded-lg border bg-card p-5" aria-labelledby="email-h">
        <h2 id="email-h" className="mb-1 font-semibold">E-mail (SMTP) — envio de cobranças</h2>
        <p className="mb-3 text-sm text-muted-foreground">Conta do domínio usada para enviar lembretes e cobranças desta empresa. Cada empresa tem a sua.</p>
        {coraAccess && email ? (<>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <p className="text-xs text-muted-foreground">{email.configured ? <>Configurada · {email.host}:{email.port} · {SECURITY_LABEL[email.security]} · remetente {email.fromName ? `${email.fromName} ` : ""}&lt;{email.fromEmail}&gt;{email.replyTo ? ` · respostas para ${email.replyTo}` : ""} · usuário e senha guardados (cifrados)</> : "Nenhuma conta cadastrada"}</p>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${email.configured ? "bg-positive-soft text-positive-foreground" : "bg-muted"}`}>{email.configured ? "Guardada" : "Pendente"}</span>
              {email.configured && <form action={removeEmailAction}><button className="rounded-md px-2.5 py-1 text-xs text-negative-foreground ring-1 ring-border">Remover</button></form>}
            </div>
          </div>
          <p className="mb-3 rounded-md bg-muted p-3 text-xs text-muted-foreground">Guardar a conta <strong>não liga o envio</strong>: nenhum e-mail sai até a fase do envio real, a homologação (SPF, DKIM e DMARC do domínio) e a sua autorização escrita. Por segurança só aceitamos o <strong>nome público</strong> do servidor (sem IP) e as portas 465, 587, 2525 ou 25.</p>
          <EmailForm current={email.configured ? { host: email.host, port: email.port, security: email.security, fromEmail: email.fromEmail, fromName: email.fromName ?? "", replyTo: email.replyTo ?? "" } : null} />
          {email.configured && <div className="mt-4 rounded-md border border-border p-3"><SmtpTestForm ownEmail={ctx.user.email ?? ""} /></div>}
          <div className="mt-6 border-t border-border pt-4" aria-labelledby="live-h">
            <h3 id="live-h" className="mb-1 font-medium">Envio real — canário</h3>
            <p className="mb-3 text-xs text-muted-foreground">O e-mail real só sai com <strong>três travas</strong> ao mesmo tempo: (1) a chave do servidor <code>EMAIL_EXTERNAL_ENABLED</code> ligada por quem opera o servidor; (2) uma autorização registrada aqui, com a referência do documento escrito, a lista de quem pode receber e o limite diário; (3) a conta cadastrada acima. Qualquer uma faltando, nada é enviado. Boleto, nota e WhatsApp continuam simulados.</p>
            <ul className="mb-3 space-y-1 text-sm">
              <li>Chave do servidor: <strong>{live?.flag ? "LIGADA" : "desligada"}</strong></li>
              <li>Autorização: {live?.authorization ? <><strong>ativa</strong> · {live.authorization.reference} · {live.authorization.allowed.length} destinatário(s) · limite {live.authorization.dailyLimit}/dia · hoje {live.sentToday}</> : <strong>nenhuma</strong>}</li>
            </ul>
            {live?.authorization && <><p className="mb-2 text-xs text-muted-foreground">Quem pode receber: {live.authorization.allowed.join(", ")}</p>
              <div className="mb-4 flex flex-wrap gap-3"><form action={revokeEmailLiveAction}><button className="rounded-md px-3 py-1.5 text-sm text-negative-foreground ring-1 ring-border">Revogar autorização</button></form></div>
              <div className="mb-4 rounded-md border border-border p-3"><TestForm /></div></>}
            {email.configured ? <details className="mb-3 rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{live?.authorization ? "Substituir a autorização" : "Registrar autorização"}</summary><div className="mt-3"><AuthorizeForm ownDomain={email.fromEmail.slice(email.fromEmail.lastIndexOf("@") + 1)} /></div></details> : <p className="text-xs text-muted-foreground">Cadastre a conta acima antes de registrar a autorização.</p>}
            {sendLog.length > 0 && <div><p className="mb-1 text-xs font-medium">Últimos envios reais (só os domínios dos destinatários)</p><ul className="divide-y divide-border text-xs text-muted-foreground">{sendLog.map((l) => <li key={l.id} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{l.at.toLocaleString("pt-BR", { timeZone: "America/Manaus" })} · {l.kind === "teste" ? "teste" : "cobrança"} · {l.domains}</span><span>{l.status}{l.error ? ` (${l.error})` : ""}</span></li>)}</ul></div>}
          </div>
        </>) : <p className="text-sm text-muted-foreground">A conta de e-mail é cadastrada somente pela diretoria.</p>}
      </section>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-1 font-semibold">Provedores de cobrança e mensagens</h2>
        <p className="mb-3 text-sm text-muted-foreground">Hoje todos funcionam em <strong>modo simulado</strong>: nada é emitido nem enviado de verdade. Cada provedor real entra numa fase própria, só com credenciais fora do Git, homologação e autorização.</p>
        {unsupportedFlagsOn().length > 0 && <p role="alert" className="mb-3 rounded-md bg-negative-soft p-3 text-sm text-negative-foreground">Atenção: há chave(s) real(is) ligada(s) ({unsupportedFlagsOn().join(", ")}) sem adaptador homologado. O envio fica bloqueado até desligá-las.</p>}
        <ul className="divide-y divide-border text-sm">
          {PROVIDER_CATALOG.map((p) => (
            <li key={p.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div><p className="font-medium">{p.label}</p><p className="text-xs text-muted-foreground">{p.note}</p></div>
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">Simulado · chave {process.env[p.flag] === "true" ? "LIGADA" : "desligada"}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-1 font-semibold">Portão da emissão real (checklist)</h2>
        <p className="mb-3 text-sm text-muted-foreground">Enquanto algum item estiver pendente, a emissão e o envio reais permanecem <strong>bloqueados</strong>. O sistema só confere se os arquivos de segredo existem; nunca lê o conteúdo. Detalhes em <code>docs/E10_GOLIVE.md</code>.</p>
        <ul className="divide-y divide-border text-sm">
          {readiness(process.env, { coraInDb, emailInDb, fiscalComplete, nfseCertInDb: certInDb, emailAuthorized: !!live?.authorization }).filter((r) => (coraAccess || (r.key !== "cora-creds" && r.key !== "smtp-creds" && r.key !== "email-authorization")) && (can(role, "company.manage") || r.key !== "fiscal-profile")).map((r) => (
            <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div><p className="font-medium">{r.label}</p><p className="text-xs text-muted-foreground">{r.detail}</p></div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${r.state === "ok" ? "bg-positive-soft text-positive-foreground" : r.state === "alerta" ? "bg-negative-soft text-negative-foreground" : "bg-muted"}`}>{r.state === "ok" ? "OK" : r.state === "alerta" ? "Atenção" : "Pendente"}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
