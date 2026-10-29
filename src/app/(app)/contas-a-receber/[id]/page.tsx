import { randomUUID } from "node:crypto";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getReceivable } from "@/modules/receivables/service";
import { METHODS, METHOD_LABEL, SITUATION_LABEL, type Situation } from "@/modules/receivables/status";
import { formatBRL, formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { PendingButton } from "@/components/k3g/pending-button";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { cancelBoletoAction, decideCancelRequestAction, payAction, recheckBoletoAction, requestCancelAction, reverseAction, withdrawCancelRequestAction } from "../actions";
import { REQUEST_STATUS_LABEL, cancelRequestsForCharge } from "@/modules/issuance/cancel-request";
import { boletoPanel, CANCEL_ERROR_LABEL, CANCEL_STATUS_LABEL } from "@/modules/issuance/cancel";
import { STATUS_LABEL as ISSUANCE_LABEL } from "@/modules/issuance/service";
import { boletoView } from "@/modules/issuance/boleto-details";

const TONE: Record<Situation, StatusTone> = { quitada: "positive", parcial: "warning", vencida: "negative", a_vencer: "info" };
const br = (d: string) => d.split("-").reverse().join("/");
const OK: Record<string, string> = { pago: "Pagamento registrado.", quitada: "Pagamento registrado. Cobrança quitada: as mensagens da régua foram interrompidas.", pedido_enviado: "Pedido de cancelamento enviado para a diretoria. Nada muda no boleto até ela decidir.", pedido_retirado: "Pedido de cancelamento retirado.", pedido_recusado: "Pedido de cancelamento recusado. O boleto continua valendo.", boleto_cancelado: "Boleto cancelado e registrado. A régua de mensagens desta cobrança foi interrompida; para cobrar de novo, solicite uma nova emissão.", boleto_sem_resposta: "O provedor não respondeu de forma conclusiva. Use «Reconsultar» antes de tentar de novo.", estornado: "Pagamento estornado. O saldo voltou; se quiser retomar a régua, use Mensagens → Programar." };

export default async function Cobranca({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; ok?: string; boleto?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "receivables.read")) return <Callout tone="warning">Seu papel não tem acesso às contas a receber.</Callout>;
  const r = await getReceivable(db, ctx.user.id, ctx.current.id, id);
  if (!r) notFound();
  const pay = can(role, "receivables.pay"), reverse = can(role, "receivables.reverse"), cancelBoletoPerm = can(role, "boletos.cancel"), requestCancelPerm = can(role, "boletos.request") && !can(role, "boletos.cancel");
  const panel = can(role, "issuance.read") ? await boletoPanel(db, ctx.user.id, ctx.current.id, r.id) : null;
  const view = can(role, "issuance.read") && sp.boleto === "1" && panel?.request?.status === "emitido" ? await boletoView(db, ctx.user.id, ctx.current.id, r.id) : null; // consulta ao vivo, só quando pedida
  const cancelRequests = can(role, "issuance.read") ? await cancelRequestsForCharge(db, ctx.user.id, ctx.current.id, r.id) : [];
  const pendingRequest = cancelRequests.find((q) => q.status === "pendente" || q.stuck);
  const canApproveNow = !!panel && panel.request?.status === "emitido" && r.payments.length === 0;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" });
  const requestKey = randomUUID().replace(/-/g, ""); // um por exibição da página: reenviar o mesmo formulário não duplica
  const openText = (r.openCents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="space-y-5">
      <PageHeader title={r.customerName} description={`${r.description} · competência ${r.competenceMonth.slice(5, 7)}/${r.competenceMonth.slice(0, 4)}`}
        actions={<AppLink href="/contas-a-receber" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a receber</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}

      <section aria-label="Valores" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Valor</p><Money cents={r.amountCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Pago</p><Money cents={r.paidCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Saldo</p><Money cents={r.openCents} className="text-xl font-semibold" /></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs uppercase tracking-wide text-muted-foreground">Situação</p><div className="mt-1"><StatusPill tone={TONE[r.situation]}>{SITUATION_LABEL[r.situation]}</StatusPill></div><p className="mt-1 text-xs text-muted-foreground">Emitida {br(r.issueDate)} · vence {br(r.dueDate)}{r.overdueDays > 0 ? ` · ${r.overdueDays} dia(s) de atraso` : ""}</p></div>
      </section>

      {pay && r.openCents > 0 && (
        <SectionCard title="Registrar pagamento (baixa manual)">
          <form action={payAction} className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="requestKey" value={requestKey} />
            <div><label htmlFor="amount" className="mb-1 block text-sm font-medium">Valor recebido (R$)</label><input id="amount" name="amount" inputMode="decimal" defaultValue={openText} required className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">O que entrou de fato (como no extrato). Parcial é permitido; o principal quitado não pode passar do saldo.</p></div>
            <div><label htmlFor="interest" className="mb-1 block text-sm font-medium">Juros/multa incluídos (R$, opcional)</label><input id="interest" name="interest" inputMode="decimal" placeholder="0,00" className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Pagou com atraso? Informe quanto do valor recebido é juros/multa.</p></div>
            <div><label htmlFor="discount" className="mb-1 block text-sm font-medium">Desconto/abatimento concedido (R$, opcional)</label><input id="discount" name="discount" inputMode="decimal" placeholder="0,00" className={inputClass} /><p className="mt-1 text-xs text-muted-foreground">Quitou pagando menos (desconto, retenção)? A cobrança é quitada pelo valor recebido + desconto.</p></div>
            <div><label htmlFor="paidAt" className="mb-1 block text-sm font-medium">Data do pagamento</label><input id="paidAt" name="paidAt" type="date" defaultValue={today} min={r.issueDate} max={today} required className={inputClass} /></div>
            <div><label htmlFor="method" className="mb-1 block text-sm font-medium">Forma</label><select id="method" name="method" defaultValue="pix" className={`${selectClass} w-full`}>{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></div>
            <div><label htmlFor="note" className="mb-1 block text-sm font-medium">Observação (opcional)</label><input id="note" name="note" maxLength={200} className={inputClass} /></div>
            <div className="sm:col-span-2"><button className={buttonClass("primary")}>Registrar pagamento</button></div>
          </form>
        </SectionCard>
      )}

      {panel && (panel.request || panel.history.length > 0) && (
        <SectionCard title="Boleto">
          {panel.request?.externalStatus === "pago" && <Callout tone="warning">O provedor informa que este boleto foi <strong>pago</strong>. Confira o recebimento e registre a baixa. As mensagens de cobrança foram interrompidas.</Callout>}
          <p className="text-sm">{panel.request ? <>Situação da emissão: <strong>{panel.request.status === "emitido" && panel.request.mode === "cora_producao" ? "Emitido (Cora PRODUÇÃO — boleto real)" : panel.request.status === "emitido" && panel.request.mode === "cora_homologacao" ? "Emitido (Cora de testes)" : (ISSUANCE_LABEL[panel.request.status] ?? panel.request.status)}</strong>{panel.request.externalStatus ? ` · no provedor: ${panel.request.externalStatus}` : ""}</> : "Sem boleto ativo (o anterior foi cancelado). Solicite uma nova emissão em Faturamento → Emissões."}</p>
          {panel.request?.status === "emitido" && !view && <p className="mt-2"><AppLink href={`/contas-a-receber/${r.id}?boleto=1`} className={buttonClass("outline", "sm")}>Ver dados do boleto</AppLink></p>}
          {view?.kind === "simulado" && <Callout tone="info">Boleto simulado: não há linha digitável nem PDF reais.</Callout>}
          {view?.kind === "indisponivel" && <Callout tone="warning">{view.reason}</Callout>}
          {view?.kind === "ok" && (
            <div className="mt-3 space-y-1 rounded-md border bg-muted/30 p-3 text-sm" role="status">
              <p><strong>Dados na Cora{view.mode === "cora_homologacao" ? " de testes (boleto de teste, não é real)" : ""}</strong> · situação: {view.details.rawStatus} · valor <Money cents={view.details.totalAmountCents} />{view.details.totalPaidCents > 0 && <> · pago <Money cents={view.details.totalPaidCents} />{view.details.paidOn ? ` em ${br(view.details.paidOn)}` : ""}</>}</p>
              {view.details.slipRegistered === false && <p className="text-warning-foreground">Atenção: a Cora informa que o boleto de código de barras ainda <strong>não está registrado</strong> na rede bancária (o QR Code Pix vale; o código de barras pode não ser aceito por alguns bancos).</p>}
              {view.details.pixEmv && <p>Pix copia e cola: <span className="num select-all break-all font-mono text-xs">{view.details.pixEmv}</span></p>}
              {view.details.digitable && <p>Linha digitável: <span className="num select-all font-mono">{view.details.digitable}</span></p>}
              {view.details.pdfUrl ? <p><a href={view.details.pdfUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline">Abrir o PDF do boleto</a></p> : <p className="text-muted-foreground">PDF indisponível.</p>}
              <p className="text-xs text-muted-foreground">Consultado agora na Cora; nada disto fica guardado aqui.</p>
            </div>
          )}
          {cancelBoletoPerm && panel.request?.status === "emitido" && r.payments.length === 0 && !panel.history.some((h) => h.status === "enviando" || h.status === "desconhecido") && (
            <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-negative-foreground">Cancelar boleto (só a diretoria)</summary>
              <form action={cancelBoletoAction} className="mt-2 grid max-w-xl gap-3">
                <input type="hidden" name="id" value={r.id} />
                <div><label htmlFor="cancel-reason" className="mb-1 block text-sm font-medium">Motivo (3 a 200 caracteres)</label><input id="cancel-reason" name="reason" required minLength={3} maxLength={200} className={inputClass} placeholder="Ex.: valor errado; vencimento a corrigir" /></div>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="confirm" required className="mt-1" /> Confirmo o cancelamento deste boleto. A ação fica registrada com meu nome, data e motivo e não pode ser desfeita.</label>
                {panel.request?.mode === "cora_producao" && <label className="flex items-start gap-2 text-sm font-medium text-negative-foreground"><input type="checkbox" name="confirmLive" required className="mt-1" /> Este é um boleto REAL (Cora produção). Confirmo que quero cancelá-lo de verdade na Cora.</label>}
                                <div><PendingButton className={buttonClass("danger")} pendingText="Cancelando…">Cancelar boleto</PendingButton></div>
              </form></details>
          )}
          {requestCancelPerm && panel.request?.status === "emitido" && r.payments.length === 0 && !pendingRequest && !panel.history.some((h) => h.status === "enviando" || h.status === "desconhecido") && (
            <details className="mt-3"><summary className="cursor-pointer text-sm font-medium">Pedir o cancelamento deste boleto (a diretoria decide)</summary>
              <form action={requestCancelAction} className="mt-2 grid max-w-xl gap-3">
                <input type="hidden" name="id" value={r.id} />
                <div><label htmlFor="req-reason" className="mb-1 block text-sm font-medium">Motivo do pedido (3 a 200 caracteres)</label><input id="req-reason" name="reason" required minLength={3} maxLength={200} className={inputClass} placeholder="Ex.: valor errado; cliente pediu novo vencimento" /></div>
                <div><PendingButton className={buttonClass("outline")} pendingText="Enviando…">Enviar pedido</PendingButton></div>
              </form></details>
          )}
          {pendingRequest && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="status">
              <p><strong>Pedido de cancelamento aguardando a diretoria</strong> · {pendingRequest.requestedByName} · {formatDateTime(pendingRequest.createdAt)}</p>
              <p className="text-muted-foreground">Motivo: {pendingRequest.reason}</p>
              {pendingRequest.stuck && <p className="mt-1 text-warning-foreground">Foi aprovado em {formatDateTime(pendingRequest.decidedAt!)}, mas o cancelamento não chegou a ser concluído. Aprove de novo para concluir.</p>}
              {cancelBoletoPerm && (
                <div className="mt-2 grid max-w-xl gap-2">
                  {canApproveNow ? (
                    <form action={decideCancelRequestAction} className="grid gap-2">
                      <input type="hidden" name="id" value={r.id} /><input type="hidden" name="requestId" value={pendingRequest.id} /><input type="hidden" name="decision" value="aprovar" />
                      <label className="flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-1" /> Confirmo o cancelamento deste boleto. A ação fica registrada com meu nome e não pode ser desfeita.</label>
                      {panel.request?.mode === "cora_producao" && <label className="flex items-start gap-2 text-sm font-medium text-negative-foreground"><input type="checkbox" name="confirmLive" required className="mt-1" /> Este é um boleto REAL (Cora produção). Confirmo que quero cancelá-lo de verdade na Cora.</label>}                      <div><PendingButton className={buttonClass("danger")} pendingText="Cancelando…">Aprovar e cancelar o boleto</PendingButton></div>
                    </form>
                  ) : <p className="text-muted-foreground">O boleto não está mais disponível para cancelar (já cancelado ou com pagamento). Você pode encerrar o pedido recusando-o.</p>}
                  {!pendingRequest.stuck && (
                    <form action={decideCancelRequestAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="id" value={r.id} /><input type="hidden" name="requestId" value={pendingRequest.id} /><input type="hidden" name="decision" value="recusar" />
                      <input name="note" aria-label="Motivo da recusa" required minLength={3} maxLength={200} placeholder="Por que recusar? (3 a 200 caracteres)" className={inputClass} />
                      <PendingButton className={buttonClass("outline", "sm")} pendingText="Recusando…">Recusar pedido</PendingButton>
                    </form>
                  )}
                </div>
              )}
              {pendingRequest.status === "pendente" && pendingRequest.requestedBy === ctx.user.id && !cancelBoletoPerm && (
                <form action={withdrawCancelRequestAction} className="mt-2"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="requestId" value={pendingRequest.id} /><PendingButton className={buttonClass("outline", "sm")} pendingText="Retirando…">Retirar meu pedido</PendingButton></form>
              )}
            </div>
          )}
          {cancelRequests.some((q) => q.status !== "pendente") && (
            <ul className="mt-3 divide-y divide-border text-sm" aria-label="Pedidos de cancelamento anteriores">
              {cancelRequests.filter((q) => q.status !== "pendente").map((q) => (
                <li key={q.id} className="py-2"><p>{formatDateTime(q.createdAt)} · pedido de {q.requestedByName} · <strong>{REQUEST_STATUS_LABEL[q.status] ?? q.status}</strong>{q.decidedByName ? ` por ${q.decidedByName}` : ""}</p><p className="text-muted-foreground">Motivo: {q.reason}{q.decisionNote ? ` · Resposta: ${q.decisionNote}` : ""}</p></li>
              ))}
            </ul>
          )}
          {cancelBoletoPerm && panel.request?.status === "emitido" && r.payments.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Há pagamento registrado: estorne-o antes de cancelar o boleto.</p>}
          {panel.history.length > 0 && (
            <ul className="mt-3 divide-y divide-border text-sm">
              {panel.history.map((h) => (
                <li key={h.id} className="py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2"><p>{formatDateTime(h.createdAt)} · {h.by}</p><StatusPill tone={h.status === "cancelado" ? "positive" : h.status === "falhou" ? "negative" : "warning"}>{CANCEL_STATUS_LABEL[h.status]}</StatusPill></div>
                  <p className="text-muted-foreground">Motivo: {h.reason}{h.attempts > 1 ? ` · ${h.attempts} tentativas` : ""}{h.lastError ? ` · ${CANCEL_ERROR_LABEL[h.lastError] ?? h.lastError}` : ""}{h.resolvedAt ? ` · decidido em ${formatDateTime(h.resolvedAt)}` : ""}</p>
                  {cancelBoletoPerm && h.status === "desconhecido" && (
                    <form action={recheckBoletoAction} className="mt-1"><input type="hidden" name="id" value={r.id} /><input type="hidden" name="cancellationId" value={h.id} /><PendingButton className={buttonClass("outline", "sm")} pendingText="Reconsultando…">Reconsultar</PendingButton></form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      <SectionCard title="Pagamentos">
        {r.payments.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum pagamento registrado.</p> : (
          <ul className="divide-y divide-border text-sm">
            {r.payments.map((p) => (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><p className={p.status === "estornado" ? "text-muted-foreground line-through" : "font-medium"}><Money cents={p.cashCents} /> · {METHOD_LABEL[p.method]} · {br(p.paidAt)}</p>
                    <p className="text-xs text-muted-foreground">Registrado por {p.registeredBy}{p.note ? ` · ${p.note}` : ""}{p.interestCents > 0 ? ` · inclui juros/multa de ${formatBRL(p.interestCents)}` : ""}{p.discountCents > 0 ? ` · desconto de ${formatBRL(p.discountCents)} (quitou ${formatBRL(p.amountCents)} do principal)` : ""}</p></div>
                  <StatusPill tone={p.status === "ativo" ? "positive" : "neutral"}>{p.status === "ativo" ? "Ativo" : "Estornado"}</StatusPill>
                </div>
                {p.status === "estornado" && <p className="mt-1 text-xs text-muted-foreground">Estornado por {p.reversedBy ?? "—"}: {p.reverseReason}</p>}
                {reverse && p.status === "ativo" && (
                  <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-negative-foreground">Estornar</summary>
                    <form action={reverseAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={r.id} /><input type="hidden" name="paymentId" value={p.id} />
                      <div className="min-w-64 flex-1"><label htmlFor={`why-${p.id}`} className="mb-1 block text-xs font-medium">Motivo (5 a 300 caracteres)</label><input id={`why-${p.id}`} name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
                      <button className={buttonClass("danger", "sm")}>Confirmar estorno</button>
                    </form></details>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Histórico">
        <ol className="space-y-2 text-sm">
          {r.events.map((e, i) => <li key={i} className="flex gap-3"><span className="w-36 shrink-0 text-xs text-muted-foreground">{formatDateTime(e.at)}</span><span>{e.text}</span></li>)}
        </ol>
      </SectionCard>
    </div>
  );
}
