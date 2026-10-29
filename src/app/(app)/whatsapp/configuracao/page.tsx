import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { SEND_PHRASE, getCompanySettings, whatsappTemplateOptions } from "@/modules/whatsapp/outbound";
import { sendOn } from "@/modules/whatsapp/service";
import { KIND_LABEL, type QueueKind } from "@/modules/messaging/templates";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { EnableForm } from "./form";
import { disableCompanySendAction, ensureWhatsappDefaultsAction } from "../actions";

export default async function ConfiguracaoWhatsApp({ searchParams }: { searchParams: Promise<{ ok?: string; erro?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.read")) return <Callout tone="warning">Seu papel não tem acesso ao WhatsApp.</Callout>;
  const authorize = can(role, "whatsapp.authorize"), tplAdmin = can(role, "messages.templates");
  const st = await getCompanySettings(db, ctx.user.id, ctx.current.id);
  const templates = can(role, "whatsapp.send") ? await whatsappTemplateOptions(db, ctx.user.id, ctx.current.id) : [];
  return (
    <div className="space-y-5">
      <PageHeader title="Configuração do WhatsApp" description={`${ctx.current.name} · cobrança de clientes, modelos e limites.`} actions={<AppLink href="/whatsapp" className={buttonClass("outline")}>Conexões</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok === "salvo" && <Callout tone="positive" role="status">Configuração salva.</Callout>}
      {sp.ok === "modelos" && <Callout tone="positive" role="status">Modelos de WhatsApp conferidos/criados.</Callout>}
      <Callout tone="warning">A WAHA <strong>não é um canal oficial</strong> do WhatsApp: o número pode ser restringido, e os limites do sistema <strong>não eliminam esse risco</strong>. Cobrar clientes exige <strong>consentimento registrado</strong>, e o pedido de parar sempre prevalece.</Callout>
      <SectionCard title="Cobrança de clientes por WhatsApp" action={st.sendEnabled ? <StatusPill tone="warning">Liberada</StatusPill> : <StatusPill tone="neutral">Desligada</StatusPill>}>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">Chave do servidor: {sendOn() ? <strong>ligada</strong> : <strong>desligada</strong>}. A empresa também precisa estar liberada aqui. Mesmo liberada, <strong>cada mensagem é manual</strong>: nada é enviado sozinho. Automação (réguas) continua <strong>desligada</strong>.</p>
          {st.sendEnabled ? (
            <>
              <p><span className="text-muted-foreground">Autorização:</span> {st.reference} · <span className="text-muted-foreground">liberada em</span> {st.authorizedAt?.toLocaleDateString("pt-BR", { timeZone: "America/Manaus" })} · <span className="text-muted-foreground">limite diário</span> {st.dailyCap}</p>
              {authorize && <form action={disableCompanySendAction}><button className={buttonClass("danger", "sm")}>Desligar cobrança por WhatsApp</button></form>}
            </>
          ) : authorize ? <EnableForm phrase={SEND_PHRASE} /> : <p>Peça à diretoria para liberar.</p>}
        </div>
      </SectionCard>
      <SectionCard title="Modelos de mensagem" action={tplAdmin ? <form action={ensureWhatsappDefaultsAction}><button className={buttonClass("outline", "sm")}>Criar/atualizar modelos padrão</button></form> : undefined}>
        {templates.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum modelo de WhatsApp ativo. {tplAdmin ? "Use o botão para criar os padrões." : "Peça à diretoria ou gerência."}</p> : (
          <ul className="space-y-3 text-sm">{templates.map((t) => (
            <li key={t.versionId}><div className="flex flex-wrap items-center gap-2"><strong>{KIND_LABEL[t.kind as QueueKind]}</strong><span className="text-xs text-muted-foreground">versão {t.version}</span>{!t.usable && <StatusPill tone="negative">indisponível: {t.issue}</StatusPill>}</div><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{t.body}</p></li>
          ))}</ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Os textos padrão são curtos, identificam a empresa e não levam dados do boleto. Para editar, use <AppLink href="/mensagens/modelos" className="underline">Mensagens → Modelos</AppLink> (a versão nova só vale depois de ativada).</p>
      </SectionCard>
    </div>
  );
}
