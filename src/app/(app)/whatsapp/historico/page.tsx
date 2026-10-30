import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { OUTBOX_STATUS_LABEL, REASON_LABEL, listOutbox } from "@/modules/whatsapp/outbound";
import { KIND_LABEL, type QueueKind } from "@/modules/messaging/templates";
import { formatBRL } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { cancelOutboxAction, dispatchOutboxAction, resolveUnknownAction, settleStaleOutboxAction } from "../actions";

const TONE: Record<string, StatusTone> = { na_fila: "info", enviando: "info", enviado: "positive", desconhecido: "warning", falhou: "negative", suprimido: "neutral", cancelado: "neutral" };
const OK: Record<string, string> = { na_fila: "Mensagem colocada na fila. Ela só sai quando você clicar em «Enviar».", enviado: "Envio processado.", cancelado: "Mensagem cancelada.", conferido: "Conferência registrada.", reservas: "Envios travados encerrados como «sem confirmação». Nada foi reenviado." };
const fmt = (d: Date | null) => (d ? d.toLocaleString("pt-BR", { timeZone: "America/Manaus" }) : "—");

export default async function Historico({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string; status?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.history")) return <Callout tone="warning">Seu papel não tem acesso ao histórico de WhatsApp.</Callout>;
  const send = can(role, "whatsapp.send"), authorize = can(role, "whatsapp.authorize");
  const rows = await listOutbox(db, ctx.user.id, ctx.current.id, { status: sp.status && OUTBOX_STATUS_LABEL[sp.status] ? sp.status : undefined });
  return (
    <div className="space-y-5">
      <PageHeader title="Histórico de WhatsApp" description={`${ctx.current.name} · cobranças enviadas, na fila e suprimidas, com o motivo.`} actions={<AppLink href="/whatsapp" className={buttonClass("outline")}>Conexões</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      <div className="flex flex-wrap gap-2 text-sm" aria-label="Filtro por situação">
        <AppLink href="/whatsapp/historico" className={buttonClass(sp.status ? "ghost" : "outline", "sm")}>Todas</AppLink>
        {Object.entries(OUTBOX_STATUS_LABEL).map(([k, v]) => <AppLink key={k} href={`/whatsapp/historico?status=${k}`} className={buttonClass(sp.status === k ? "outline" : "ghost", "sm")}>{v}</AppLink>)}
      </div>
      {authorize && rows.some((r) => r.status === "enviando" && Date.now() - (r.finishedAt ?? r.createdAt).getTime() > 10 * 60_000) && (
        <form action={settleStaleOutboxAction}><Callout tone="warning">Há envio travado em «Enviando» há mais de 10 minutos (o servidor caiu no meio). Ele ocupa o limite do dia. <button className={buttonClass("outline", "sm", "ml-2")}>Encerrar como sem confirmação</button></Callout></form>
      )}
      <SectionCard>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma mensagem ainda. Abra uma cobrança em Contas a receber e use «Enviar por WhatsApp».</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="pb-2 pr-4 font-medium">Cliente</th><th className="pb-2 pr-4 font-medium">Cobrança</th><th className="pb-2 pr-4 font-medium">Situação</th><th className="pb-2 pr-4 font-medium">Quando</th><th className="pb-2 font-medium">Ações</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="py-2 pr-4"><div>{r.customer}</div><div className="text-xs text-muted-foreground">{r.phone}</div></td>
                <td className="py-2 pr-4"><div>{formatBRL(r.amountCents)}</div><div className="text-xs text-muted-foreground">{KIND_LABEL[r.milestone as QueueKind]} · venc. {r.due.slice(8, 10)}/{r.due.slice(5, 7)}{r.origin === "regua" && <> · <strong>régua automática</strong></>}</div></td>
                <td className="py-2 pr-4"><StatusPill tone={TONE[r.status] ?? "neutral"}>{OUTBOX_STATUS_LABEL[r.status] ?? r.status}</StatusPill>
                  {r.reason && <div className="mt-1 text-xs text-muted-foreground">{REASON_LABEL[r.reason] ?? r.reason}</div>}
                  {r.delivery && <div className="mt-1 text-xs text-muted-foreground">{r.delivery === "lido" ? "Lida" : "Entregue"} {fmt(r.readAt ?? r.deliveredAt)}</div>}</td>
                <td className="py-2 pr-4 text-muted-foreground">{fmt(r.sentAt ?? r.finishedAt ?? r.createdAt)}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-2">
                    {send && r.status === "na_fila" && <form action={dispatchOutboxAction}><input type="hidden" name="id" value={r.id} /><button className={buttonClass("primary", "sm")}>Enviar</button></form>}
                    {send && r.status === "na_fila" && <form action={cancelOutboxAction}><input type="hidden" name="id" value={r.id} /><button className={buttonClass("outline", "sm")}>Cancelar</button></form>}
                    {authorize && r.status === "desconhecido" && (<>
                      <form action={resolveUnknownAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="outcome" value="enviado" /><button className={buttonClass("outline", "sm")}>Confirmei: foi enviada</button></form>
                      <form action={resolveUnknownAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="outcome" value="falhou" /><button className={buttonClass("outline", "sm")}>Confirmei: NÃO foi</button></form>
                    </>)}
                  </div>
                </td>
              </tr>
            ))}</tbody></table></div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">«Sem confirmação» = a WAHA não respondeu: a mensagem pode ter chegado e <strong>nunca é reenviada sozinha</strong>. Confira com o cliente e use «Confirmei…». O texto enviado fica cifrado e aparece só no registro; as listas mostram o telefone mascarado.</p>
      </SectionCard>
    </div>
  );
}
