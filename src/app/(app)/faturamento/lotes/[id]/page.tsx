import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getBatch } from "@/modules/billing/batches";
import { invoicesForCharges } from "@/modules/invoices/service";
import { DUPLICATE_ALERT, duplicateAlerts } from "@/modules/issuance/service";
import { getIssuanceSettings } from "@/modules/issuance/service";
import { WARNING_LABEL, type Warning } from "@/modules/billing/calendar";
import { Callout, Money, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { formatDateTime } from "@/lib/format";
import { approveAction, attachInvoiceAction, cancelAction, refreshAction, removeInvoiceAction, reopenAction } from "../actions";
import { requestBatchIssuanceAction } from "../../emissoes/actions";
import { STATUS_LABEL, STATUS_TONE } from "../status";

const br = (d: string) => d.split("-").reverse().join("/");

export default async function Lote({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "billing.read")) return <Callout tone="warning">Seu papel não tem acesso aos lotes de cobrança.</Callout>;
  const r = await getBatch(db, ctx.user.id, ctx.current.id, id);
  if (!r) notFound();
  const { batch: b, stale } = r;
  const notas = await invoicesForCharges(db, ctx.user.id, ctx.current.id, r.charges.map((c) => c.id));
  const alertas = await duplicateAlerts(db, ctx.user.id, ctx.current.id, r.charges.map((c) => c.id));
  const pendentes = r.charges.filter((c) => c.jointInvoice && !notas.has(c.id)).length;
  const semNota = r.charges.filter((c) => !c.jointInvoice && c.customerIssuesInvoice && !notas.has(c.id)).length; // cliente «emite nota fiscal» sem exigência de NF junto: a nota é esperada, mas o e-mail não espera
  const approve = can(role, "billing.approve"), write = can(role, "billing.write");
  const prov = can(role, "issuance.read") ? (await getIssuanceSettings(db, ctx.user.id, ctx.current.id)).boletoProvider : "simulado";
  const stage = prov === "cora_homologacao", prod = prov === "cora_producao"; // boletos desta empresa: Cora de testes ou Cora de PRODUÇÃO (reais)
  const OK: Record<string, string> = { aprovado: "Lote aprovado. Nada foi emitido: aprovar não emite; a emissão é solicitada à parte, em Emissões.", reaberto: "Lote reaberto: volta a ser prévia e precisa de nova aprovação.", atualizado: "Prévia atualizada.", nota: "Nota fiscal anexada. O e-mail desta cobrança passa a levar boleto e nota juntos.", nota_trocada: "Nota fiscal substituída (a anterior fica no histórico).", nota_removida: "Nota fiscal removida desta cobrança." };

  return (
    <div className="space-y-5">
      <PageHeader title={`Lote de emissão ${br(b.issueDate)}`} description={ctx.current.name}
        actions={<span className="flex gap-2"><AppLink href="/faturamento/ajustes" className={buttonClass("outline")}>Ajustes</AppLink><AppLink href="/faturamento/lotes" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Lotes</AppLink></span>} />
      {sp.ok && OK[sp.ok] && <Callout tone="positive" role="status">{OK[sp.ok]}</Callout>}
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Situação</p><p className="mt-1"><StatusPill tone={STATUS_TONE[b.status as keyof typeof STATUS_TONE]}>{STATUS_LABEL[b.status as keyof typeof STATUS_LABEL]}</StatusPill></p>
          {b.approvedAt && <p className="mt-1 text-xs text-muted-foreground">Aprovado em {formatDateTime(b.approvedAt)}</p>}</div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Cobranças</p><p className="num mt-1 text-2xl font-semibold">{r.charges.length}</p></div>
        <div className="rounded-lg border bg-card p-4"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total</p><p className="mt-1 text-2xl font-semibold"><Money cents={r.totalCents} /></p></div>
      </div>

      <Callout tone={prod ? "warning" : "info"}>{prod
        ? <>Aprovar <strong>não emite</strong> nada. Ao solicitar e processar a emissão, os boletos desta empresa são criados na <strong>Cora de PRODUÇÃO: são REAIS e cobram o cliente</strong>. NFS-e e mensagens continuam simuladas.</>
        : stage
        ? <>Aprovar <strong>não emite</strong> nada. Ao solicitar a emissão, os boletos desta empresa nascem na <strong>Cora de testes</strong> (não são reais e não cobram ninguém); NFS-e e mensagens continuam simuladas.</>
        : <>Simulação: aprovar <strong>não emite</strong> boleto, nota fiscal nem mensagem.</>}</Callout>

      {stale.any && (
        <Callout tone="warning" role="alert">
          <strong>Contratos mudaram desde esta {b.status === "aprovado" ? "aprovação" : "prévia"}</strong> ({stale.added} nova(s), {stale.removed} a sair, {stale.changed} alterada(s)).{" "}
          {b.status === "aprovado" ? "Reabra o lote para revalidar." : "Atualize a prévia antes de aprovar."}
        </Callout>
      )}
      {r.exceptions.length > 0 && (
        <section aria-label="Fora do lote" className="rounded-lg border border-warning/40 bg-warning-soft p-4 text-warning-foreground">
          <h2 className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" aria-hidden /> Fora do lote — precisa de revisão ({r.exceptions.length})</h2>
          <ul className="mt-2 space-y-1 text-sm">{r.exceptions.map((i, k) => <li key={k}>{i.customerName} — {i.description}: {i.reason}</li>)}</ul>
        </section>
      )}

      {pendentes > 0 && <Callout tone="warning">{pendentes} cobrança(s) deste lote exige(m) <strong>boleto + nota fiscal</strong> e ainda não tem a nota anexada. O e-mail real dessas cobranças espera pela nota; os demais seguem normalmente.</Callout>}
      {semNota > 0 && <Callout tone="info">{semNota} cobrança(s) de cliente(s) marcado(s) como <strong>«emite nota fiscal»</strong> ainda sem a nota anexada. O e-mail dessas cobranças <strong>não espera</strong> a nota; anexe-a quando estiver pronta.</Callout>}

      <SectionCard title="Cobranças do lote">
        {r.charges.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma cobrança neste lote.</p> : (
          <ul className="divide-y divide-border">
            {r.charges.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <AppLink href={`/contratos/${c.contractId}`} className="font-medium hover:underline">{c.customerName}</AppLink>
                  <p className="text-muted-foreground">{c.description} · competência {c.competenceMonth.slice(5, 7)}/{c.competenceMonth.slice(0, 4)} · vence {br(c.dueDate)}{c.jointInvoice ? " · boleto + NF" : ""}</p>
                  {(c.jointInvoice || c.customerIssuesInvoice) && <p className="text-xs"><AppLink href={`/faturamento/nfse/${c.id}`} className="underline">Prévia da NFS-e</AppLink> <span className="text-muted-foreground">(só visualização, nada é emitido)</span></p>}
                  {!c.customerIssuesBoleto && <p className="text-xs font-medium text-warning-foreground">Cliente marcado como «não emite boleto»: fica de fora da emissão de boletos (muda em Clientes → Editar).</p>}
                  {alertas.has(c.id) && <Callout tone="warning" role="alert"><strong>ALERTA DE DUPLICIDADE.</strong> {DUPLICATE_ALERT[alertas.get(c.id)!.code]} Este é o único boleto parado; os outros do lote seguem. <AppLink href="/faturamento/emissoes?status=falhou" className="underline">Ver em Emissões</AppLink></Callout>}
                  {(c.warnings as Warning[]).length > 0 && <p className="text-xs text-muted-foreground">{(c.warnings as Warning[]).map((w) => WARNING_LABEL[w]).join("; ")}</p>}
                  {(() => {
                    const nf = notas.get(c.id);
                    if (!nf && !c.jointInvoice && !c.customerIssuesInvoice) return null;
                    return (
                      <div className="mt-1 text-xs">
                        {nf ? (
                          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                            <span>Nota fiscal nº <strong>{nf.number}</strong> · emitida em {br(nf.issuedOn)} · segue junto do boleto no e-mail</span>
                            <a href={`/faturamento/notas/${nf.id}`} className="underline">Baixar PDF</a>
                            {write && <form action={removeInvoiceAction} className="inline"><input type="hidden" name="id" value={b.id} /><input type="hidden" name="chargeId" value={c.id} /><button className="underline">Remover</button></form>}
                          </div>
                        ) : <p className="font-medium text-warning-foreground">Falta a nota fiscal: o e-mail desta cobrança espera por ela.</p>}
                        {write && (
                          <details className="mt-1">
                            <summary className="cursor-pointer underline">{nf ? "Substituir a nota" : "Anexar a nota fiscal"}</summary>
                            <form action={attachInvoiceAction} encType="multipart/form-data" className="mt-2 grid max-w-xl gap-2 sm:grid-cols-2">
                              <input type="hidden" name="id" value={b.id} /><input type="hidden" name="chargeId" value={c.id} />
                              <div><label htmlFor={`nf-${c.id}-number`} className="mb-1 block font-medium">Número da nota</label><input id={`nf-${c.id}-number`} name="number" required maxLength={30} className={inputClass} /></div>
                              <div><label htmlFor={`nf-${c.id}-issuedOn`} className="mb-1 block font-medium">Emitida em</label><input id={`nf-${c.id}-issuedOn`} name="issuedOn" type="date" required className={inputClass} /></div>
                              <div><label htmlFor={`nf-${c.id}-verificationCode`} className="mb-1 block font-medium">Código de verificação (opcional)</label><input id={`nf-${c.id}-verificationCode`} name="verificationCode" maxLength={80} className={inputClass} /></div>
                              <div><label htmlFor={`nf-${c.id}-file`} className="mb-1 block font-medium">PDF da nota (até 2 MB)</label><input id={`nf-${c.id}-file`} name="file" type="file" accept="application/pdf" required className={inputClass} /></div>
                              <div className="sm:col-span-2"><button className={buttonClass("outline")}>{nf ? "Substituir" : "Anexar"}</button></div>
                            </form>
                          </details>
                        )}
                      </div>
                    );
                  })()}
                  {c.adjustments.length > 0 && <p className="text-xs text-muted-foreground">Contrato <Money cents={c.baseCents} /> {c.adjustments.map((a) => `${a.kind === "desconto" ? "−" : "+"} ${a.description} ${(a.amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`).join(" ")}</p>}
                </div>
                <Money cents={c.amountCents} className="font-semibold" />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Ações">
        <div className="flex flex-wrap items-start gap-3">
          {b.status === "rascunho" && write && (
            <form action={refreshAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="issueDate" value={b.issueDate} /><button className={buttonClass("outline")}>Atualizar prévia</button></form>
          )}
          {b.status === "rascunho" && approve && r.charges.length > 0 && (
            <form action={approveAction}><input type="hidden" name="id" value={b.id} /><input type="hidden" name="hash" value={r.hash} /><button className={buttonClass("success")} disabled={stale.any}>Aprovar lote</button></form>
          )}
          {b.status === "rascunho" && write && (
            <form action={cancelAction}><input type="hidden" name="id" value={b.id} /><button className={buttonClass("danger")}>Cancelar lote</button></form>
          )}
          {b.status === "aprovado" && approve && (
            <form action={reopenAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={b.id} />
              <div><label htmlFor="reason" className="mb-1 block text-xs font-medium">Motivo para reabrir</label><input id="reason" name="reason" required minLength={5} maxLength={300} className={inputClass} /></div>
              <button className={buttonClass("outline")}>Reabrir para revalidar</button>
            </form>
          )}
        </div>
        {b.status === "aprovado" && can(role, "issuance.request") && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-2 text-sm font-medium">{prod ? "Emissão (boleto REAL na Cora de produção; NFS-e simulada)" : stage ? "Emissão (boleto na Cora de testes; NFS-e simulada)" : "Emissão (simulada)"}</p>
            <div className="flex flex-wrap gap-2">
              {(["boleto", "nfse"] as const).map((k) => (
                <form key={k} action={requestBatchIssuanceAction}><input type="hidden" name="batchId" value={b.id} /><input type="hidden" name="kind" value={k} /><button className={buttonClass("outline")}>{k === "boleto" ? "Solicitar boletos" : "Solicitar NFS-e"}</button></form>
              ))}
              <AppLink href="/faturamento/emissoes" className={buttonClass("ghost")}>Ver emissões</AppLink>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{prod
              ? <>Enfileira a solicitação. O boleto <strong>REAL</strong> só nasce quando a emissão estiver liberada e a rodada for processada e <strong>confirmada</strong> em Emissões (modo canário: poucos por dia). A plataforma confere se a Cora já tem um boleto igual antes de emitir. NFS-e continua simulada.</>
              : stage
              ? <>Enfileira a solicitação. O boleto só nasce (na <strong>Cora de testes</strong>, sem valor real) quando a emissão estiver liberada e for processada, em Emissões. A NFS-e continua simulada.</>
              : <>Apenas enfileira a solicitação no motor <strong>simulado</strong>. Nenhum boleto ou nota real é emitido.</>}</p>
          </div>
        )}
        {b.status === "rascunho" && !approve && <p className="mt-2 text-sm text-muted-foreground">Gerente ou diretoria aprovam o lote.</p>}
        {b.status === "rascunho" && approve && <p className="mt-2 text-xs text-muted-foreground">Quem gerou a prévia não a aprova (exige outro gerente ou a diretoria). Você aprova exatamente o conteúdo exibido acima.</p>}
      </SectionCard>
    </div>
  );
}
