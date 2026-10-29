import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listInbox, listTriage } from "@/modules/whatsapp/inbound";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, selectClass } from "@/components/k3g/button";
import { handleInboxAction, triageAction } from "../actions";

const CLASS_LABEL: Record<string, string> = { resposta: "Resposta", opt_out: "Pediu para parar", opt_out_ambiguo: "Pediu para parar (a confirmar)", sem_numero: "Número não identificado" };
const HANDLING_LABEL: Record<string, string> = { novo: "Nova", em_atendimento: "Em atendimento", resolvido: "Resolvida" };
const HTONE: Record<string, StatusTone> = { novo: "warning", em_atendimento: "info", resolvido: "positive" };
const fmt = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "America/Manaus" });
const act = (op: string, id: string, label: string, v: "outline" | "danger" = "outline") => <form action={handleInboxAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} /><button className={buttonClass(v, "sm")}>{label}</button></form>;

export default async function Entrada({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.history")) return <Callout tone="warning">Seu papel não tem acesso à caixa de entrada do WhatsApp.</Callout>;
  const send = can(role, "whatsapp.send"), consent = can(role, "whatsapp.consent"), authorize = can(role, "whatsapp.authorize");
  const [inbox, triage] = await Promise.all([listInbox(db, ctx.user.id, ctx.current.id), listTriage(db, ctx.user.id)]);
  const open = inbox.filter((i) => i.handling !== "resolvido").length;
  return (
    <div className="space-y-5">
      <PageHeader title="Caixa de entrada do WhatsApp" description={`${ctx.current.name} · respostas de clientes. Sem resposta automática e sem robô.`} actions={<AppLink href="/whatsapp" className={buttonClass("outline")}>Conexões</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && <Callout tone="positive" role="status">Feito.</Callout>}
      <Callout tone="info">Quando o cliente <strong>responde</strong>, a cobrança dele fica <strong>suspensa</strong> até você marcar a conversa como <strong>resolvida</strong>. Quem escreve <strong>PARAR</strong> (ou parecido) é bloqueado <strong>na hora</strong>, sem resposta automática. Para responder ao cliente, use o próprio WhatsApp do aparelho conectado.</Callout>

      <SectionCard title={`Respostas desta empresa${open ? ` (${open} em aberto)` : ""}`}>
        {inbox.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma resposta ainda.</p> : (
          <ul className="divide-y" aria-label="Respostas de clientes">{inbox.map((i) => (
            <li key={i.id} className="space-y-2 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{i.customer ?? "Contato sem cadastro"}</strong><span className="text-muted-foreground">{i.phone}</span><span className="text-xs text-muted-foreground">{fmt(i.at)}</span>
                <StatusPill tone={i.classification === "resposta" ? "info" : "negative"}>{CLASS_LABEL[i.classification] ?? i.classification}</StatusPill>
                <StatusPill tone={HTONE[i.handling] ?? "neutral"}>{HANDLING_LABEL[i.handling] ?? i.handling}</StatusPill>
                {i.dispute && <StatusPill tone="warning">Contestação</StatusPill>}
                {i.needsReview && <StatusPill tone="warning">Revisar</StatusPill>}
                {i.optoutApplied && <StatusPill tone="negative">{i.optoutApplied === "global" ? "Bloqueado em todas as empresas" : "Bloqueado nesta empresa"}</StatusPill>}
              </div>
              <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2">{i.body || (i.kind === "midia" ? "(anexo/mídia: não é baixado pelo sistema)" : "—")}</p>
              <div className="flex flex-wrap gap-2">
                {send && i.handling === "novo" && act("atender", i.id, "Em atendimento")}
                {send && i.handling !== "resolvido" && act("resolver", i.id, "Resolver")}
                {send && !i.dispute && act("contestacao", i.id, "Marcar contestação")}
                {send && i.dispute && act("limpar_contestacao", i.id, "Limpar contestação")}
                {consent && !i.optoutApplied && act("parar_empresa", i.id, "Registrar: parar nesta empresa", "danger")}
                {authorize && i.optoutApplied !== "global" && act("parar_todas", i.id, "Registrar: parar em todas as empresas", "danger")}
              </div>
            </li>
          ))}</ul>
        )}
      </SectionCard>

      {triage.length > 0 && (
        <SectionCard title="Triagem: mensagens sem empresa definida">
          <p className="mb-3 text-sm text-muted-foreground">Estas mensagens não puderam ser ligadas com segurança a uma empresa (número desconhecido ou usado por mais de uma empresa). <strong>Só quem é diretoria em todas as empresas da conexão</strong> vê esta lista. Nenhuma empresa as vê antes de você escolher.</p>
          <ul className="divide-y" aria-label="Triagem">{triage.map((t) => (
            <li key={t.id} className="space-y-2 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong>{t.phone ?? "número não identificado"}</strong><span className="text-xs text-muted-foreground">{fmt(t.at)}</span>
                <StatusPill tone={t.classification === "resposta" ? "info" : "negative"}>{CLASS_LABEL[t.classification] ?? t.classification}</StatusPill>
                {t.optoutApplied && <StatusPill tone="negative">Bloqueado em todas as empresas</StatusPill>}</div>
              <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-2">{t.body || "—"}</p>
              <div className="flex flex-wrap items-end gap-2">
                <form action={triageAction} className="flex flex-wrap items-end gap-2"><input type="hidden" name="id" value={t.id} />
                  <div><label htmlFor={`tc-${t.id}`} className="mb-1 block text-xs font-medium">Atribuir à empresa</label><select id={`tc-${t.id}`} name="companyId" className={`${selectClass} h-9`}>{t.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
                  <button className={buttonClass("outline", "sm")}>Atribuir</button></form>
                <form action={triageAction}><input type="hidden" name="id" value={t.id} /><input type="hidden" name="op" value="descartar" /><button className={buttonClass("ghost", "sm")}>Descartar</button></form>
              </div>
            </li>
          ))}</ul>
        </SectionCard>
      )}
    </div>
  );
}
