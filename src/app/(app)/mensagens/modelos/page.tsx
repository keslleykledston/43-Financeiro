import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listTemplates } from "@/modules/messaging/service";
import { CHANNELS, CHANNEL_LABEL, KINDS, KIND_LABEL } from "@/modules/messaging/templates";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { defaultsAction } from "../actions";

export default async function Modelos({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "messages.read")) return <Callout tone="warning">Seu papel não tem acesso aos modelos de mensagem.</Callout>;
  const ts = await listTemplates(db, ctx.user.id, ctx.current.id);
  const by = new Map(ts.map((t) => [`${t.kind}|${t.channel}`, t]));
  const manage = can(role, "messages.templates");
  const missing = KINDS.length * CHANNELS.length - ts.filter((t) => t.active).length;

  return (
    <div className="space-y-5">
      <PageHeader title="Modelos de mensagem" description={`${ctx.current.name} · texto de cada etapa da régua.`}
        actions={<AppLink href="/mensagens" className={buttonClass("outline")}>Fila</AppLink>} />
      <Callout tone="info">Os textos são <strong>texto simples</strong> com campos como {"{{cliente}}"} e {"{{valor}}"}. Editar cria um rascunho; só vale depois de <strong>ativar</strong>. Simulação: nada é enviado.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok?.startsWith("padroes") && <Callout tone="positive" role="status">Modelos padrão criados: {sp.ok.split(":")[1]}.</Callout>}
      {manage && missing > 0 && (
        <form action={defaultsAction}><button className={buttonClass("primary")}>Criar modelos padrão ({missing} faltando)</button></form>
      )}
      <SectionCard title="Etapas da régua">
        <ul className="divide-y divide-border">
          {KINDS.flatMap((k) => CHANNELS.map((c) => {
            const t = by.get(`${k}|${c}`);
            return (
              <li key={`${k}${c}`} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium">{KIND_LABEL[k]} · {CHANNEL_LABEL[c]}</p>
                  <p className="text-xs text-muted-foreground">{t?.active ? `Versão ${t.active.version} ativa` : "Sem versão ativa — a etapa não entra na fila"}{t?.draft ? ` · rascunho v${t.draft.version} aguardando ativação` : ""}</p>
                </div>
                <span className="flex items-center gap-2">
                  <StatusPill tone={t?.active ? "positive" : "warning"}>{t?.active ? "Ativo" : "Pendente"}</StatusPill>
                  <AppLink href={`/mensagens/modelos/${k}/${c}`} className={buttonClass("outline", "sm")}>{manage ? "Editar" : "Ver"}</AppLink>
                </span>
              </li>
            );
          }))}
        </ul>
      </SectionCard>
    </div>
  );
}
