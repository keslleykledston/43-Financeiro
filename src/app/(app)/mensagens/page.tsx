import { MessageSquare } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listQueue } from "@/modules/messaging/service";
import { CHANNEL_LABEL, KIND_LABEL } from "@/modules/messaging/templates";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { processAction, scheduleAction } from "./actions";

const TONE: Record<string, StatusTone> = { pendente: "info", bloqueado: "warning", simulado: "positive", cancelado: "neutral" };
const LABEL: Record<string, string> = { pendente: "Aguardando", bloqueado: "Bloqueado", simulado: "Simulado", cancelado: "Cancelado" };
const FILTERS = ["pendente", "bloqueado", "simulado", "cancelado"] as const;
const br = (d: string) => d.split("-").reverse().join("/");

function okText(ok?: string) {
  const [k, ...n] = (ok ?? "").split(":"); const v = n.map(Number);
  const waiting = k === "processado" && n[5] ? ` Aviso: ${decodeURIComponent(n[5])}.` : "";
  if (k === "programado") return `Fila programada: ${v[0]} novo(s), ${v[1]} bloqueado(s) por falta de contato, ${v[2]} sem modelo ativo, ${v[3]} já no passado, ${v[4]} cancelado(s).`;
  if (k === "processado") return `Simulação concluída: ${v[0]} mensagem(ns) processada(s), ${v[1]} cancelada(s)${v[2] ? `, ${v[2]} bloqueada(s)` : ""}${v[3] ? `, ${v[3]} com falha` : ""}${v[4] ? `, ${v[4]} aguardando canal desligado` : ""}. Nada foi enviado.${waiting}`;
  return "";
}

export default async function Mensagens({ searchParams }: { searchParams: Promise<{ status?: string; erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "messages.read")) return <Callout tone="warning">Seu papel não tem acesso às mensagens.</Callout>;
  const status = FILTERS.find((f) => f === sp.status);
  const { items, counts } = await listQueue(db, ctx.user.id, ctx.current.id, status);
  const write = can(role, "messages.write");
  const msg = okText(sp.ok);

  return (
    <div className="space-y-5">
      <PageHeader title="Mensagens" description={`${ctx.current.name} · régua de cobrança por e-mail e WhatsApp.`}
        actions={<div className="flex gap-2"><AppLink href="/mensagens/modelos" className={buttonClass("outline")}>Modelos</AppLink><AppLink href="/mensagens/configuracao" className={buttonClass("outline")}>Configuração</AppLink></div>} />
      <Callout tone="info">Simulação: a fila mostra o que <strong>seria</strong> enviado. Nenhum e-mail ou WhatsApp sai do sistema. O envio real só será ligado em fase própria, com provedores homologados e autorização.</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {msg && <Callout tone="positive" role="status">{msg}</Callout>}

      <SectionCard title="Fila" action={write ? (
        <div className="flex flex-wrap gap-2">
          <form action={scheduleAction}><button className={buttonClass("outline", "sm")}>Programar mensagens</button></form>
          <form action={processAction}><button className={buttonClass("primary", "sm")} title="Ignora a janela de horário; respeita pausa, canais e limites">Processar vencidos (simulação)</button></form>
        </div>
      ) : undefined}>
        <nav aria-label="Filtrar por situação" className="mb-3 flex flex-wrap gap-2 text-sm">
          <AppLink href="/mensagens" className={buttonClass(status ? "ghost" : "outline", "sm")}>Abertas e simuladas</AppLink>
          {FILTERS.map((f) => (
            <AppLink key={f} href={`/mensagens?status=${f}`} className={buttonClass(status === f ? "outline" : "ghost", "sm")}>{LABEL[f]} · {counts[f] ?? 0}</AppLink>
          ))}
        </nav>
        {items.length === 0 ? (
          <EmptyState icon={MessageSquare} title="Fila vazia" description="Aprove um lote de cobrança, crie os modelos e use “Programar mensagens” para montar a régua (emissão, D-3, D0, D+3, D+7 e revisão D+15)." action={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}>Lotes de cobrança</AppLink>} />
        ) : (
          <ul className="divide-y divide-border">
            {items.map((i) => (
              <li key={i.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{i.customerName}</p>
                    <p className="text-xs text-muted-foreground">{br(i.scheduledFor)} · {KIND_LABEL[i.kind as keyof typeof KIND_LABEL]} · {CHANNEL_LABEL[i.channel as keyof typeof CHANNEL_LABEL]} · vence {br(i.dueDate)}</p>
                  </div>
                  <span className="flex items-center gap-3"><Money cents={i.amountCents} /><StatusPill tone={TONE[i.status]}>{LABEL[i.status]}</StatusPill></span>
                </div>
                {i.blockedReason && <p className="mt-1 text-xs text-warning-foreground">{i.blockedReason}. Cadastre o contato financeiro e programe de novo.</p>}
                {i.renderedBody && (
                  <details className="mt-2 rounded-md border border-border bg-muted/40 p-3">
                    <summary className="cursor-pointer text-xs font-medium">Ver texto simulado</summary>
                    {i.renderedSubject && <p className="mt-2 text-xs font-medium">Assunto: {i.renderedSubject}</p>}
                    <pre className="mt-2 whitespace-pre-wrap font-sans text-xs">{i.renderedBody}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
