import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { nextRenewal } from "@/modules/contracts/alerts";
import { getContract, KIND_LABEL, STATUS_LABEL, type AmendmentKind, type ContractStatus, type Terms } from "@/modules/contracts/service";
import { listNotes } from "@/modules/notes/service";
import { NotesBlock } from "@/components/k3g/notes-block";
import { billingSchedule, WARNING_LABEL } from "@/modules/billing/calendar";
import { formatBRL, formatDate, formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { ContractForm } from "../contract-form";
import { INDEX_CODES, INDEX_LABEL, getAdjustmentRule, parsePctBps, suggestedCents } from "@/modules/contracts/adjustment";
import { cancelScheduleAction, saveRuleAction, commissionAction, decideAction, noteAction, proposeAction, statusAction } from "../actions";
import { percentLabel } from "@/modules/commissions/calc";

const TONE: Record<ContractStatus, StatusTone> = { rascunho: "info", ativo: "positive", suspenso: "warning", encerrado: "neutral" };
const VTONE = { pendente: "info", aprovada: "positive", rejeitada: "negative", substituida: "neutral", agendada: "warning", cancelada: "neutral" } as const;
const brMoney = (c: number) => (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // 250000 → "2.500,00" (aceito pelo parser estrito)

export default async function Detalhe({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; regra?: string; pct?: string; agendado?: string; proposta?: string; comissao?: string; aprovado?: string; comentario?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.read")) return <Callout tone="warning">Seu papel não tem acesso a contratos.</Callout>;
  const c = await getContract(db, ctx.user.id, ctx.current.id, id);
  if (!c) notFound();
  const write = can(role, "contracts.write"), approve = can(role, "contracts.approve"), commRead = can(role, "commissions.read"), commManage = can(role, "commissions.manage");
  const notes = await listNotes(db, ctx.user.id, ctx.current.id, { contractId: id });
  const pending = c.versions.find((v) => v.state === "pendente");
  const scheduled = c.versions.find((v) => v.state === "agendada");
  const rule = await getAdjustmentRule(db, ctx.user.id, ctx.current.id, c.id);
  let pctBps: number | null = null; try { pctBps = sp.pct ? parsePctBps(sp.pct) : null; } catch { pctBps = null; }
  const proposed = pctBps !== null && pctBps > 0 ? suggestedCents(c.amountCents, pctBps) : null; // valor pré-preenchido do aditivo de reajuste (continua passando pela aprovação)
  const tooBig = pctBps !== null && pctBps > 0 && proposed === null; // passaria do teto do valor mensal: não pré-preenche
  const nextComp = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" }).slice(0, 7);
  const sched = billingSchedule({ competenceMonth: nextComp, dueDay: c.dueDay, jointInvoice: c.invoiceJointRequired, issueDayOverride: c.issueDayOverride });
  const status = c.status as ContractStatus;
  const t = (v: Terms) => `${formatBRL(v.monthlyAmountCents)} · vence dia ${v.dueDay} · ${v.invoiceJointRequired ? "NF junto" : "NF separada"} · ${formatDate(v.startAt)}${v.endAt ? ` a ${formatDate(v.endAt)}` : " (renova sozinho)"}`;
  return (
    <div className="max-w-3xl space-y-5">
      <AppLink href="/contratos" className="text-sm text-primary">← Voltar</AppLink>
      <PageHeader title={c.customer.displayName} description={c.customer.displayName !== c.customer.legalName ? `${c.description} · razão social: ${c.customer.legalName}` : c.description} actions={<StatusPill tone={TONE[status]}>{STATUS_LABEL[status]}</StatusPill>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.aprovado && <Callout tone="positive" role="status">Aditivo aprovado e já em vigor. Cobranças já geradas não mudam; as próximas prévias de lote usam os novos termos.</Callout>}
      {sp.agendado && <Callout tone="positive" role="status">Aditivo aprovado e <strong>agendado</strong>: os termos vigentes continuam os mesmos até a data de efeito; nesse dia o sistema aplica sozinho.</Callout>}
      {scheduled && <Callout tone="warning" role="status">Há um aditivo <strong>agendado para {formatDate(scheduled.effectiveOn!)}</strong> ({t(scheduled.terms)}). Até lá os termos acima continuam valendo. Novas alterações ficam bloqueadas até ele valer ou ser cancelado.</Callout>}
      {sp.comentario && <Callout tone="positive" role="status">Comentário registrado.</Callout>}
      {sp.proposta && <Callout tone="positive" role="status">Alteração enviada para aprovação. Os termos vigentes continuam os mesmos até lá.</Callout>}
      {c.customer.status !== "ativo" && <Callout tone="warning">Cliente <strong>{c.customer.status}</strong>: este contrato não gera cobrança enquanto o cliente não voltar a ser ativo.</Callout>}

      <SectionCard title="Termos vigentes">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Valor mensal</dt><dd className="font-semibold"><Money cents={c.amountCents} /></dd></div>
          <div><dt className="text-muted-foreground">Vencimento</dt><dd>dia {c.dueDay} (competência M, vence em M+1)</dd></div>
          <div><dt className="text-muted-foreground">Vigência</dt><dd>{formatDate(c.startAt)}{c.endAt ? ` a ${formatDate(c.endAt)}` : " · renova sozinho a cada 12 meses"}{!c.endAt && status === "ativo" ? ` (próxima: ${formatDate(nextRenewal(c.startAt, new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" })))})` : ""}</dd></div>
          <div><dt className="text-muted-foreground">Nota fiscal</dt><dd>{c.invoiceJointRequired ? "Emitida junto do boleto" : "Regra fiscal a definir (separada)"}</dd></div>
        </dl>
        {status === "ativo" && (
          <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Próxima emissão prevista (competência {nextComp})</p>
            {sched.review ? <p className="text-warning-foreground">Precisa de revisão: {sched.reason}</p>
              : <p>Boleto{c.invoiceJointRequired ? " + NF" : ""} em <strong>{formatDate(sched.issueDate!)}</strong>, vencimento <strong>{formatDate(sched.dueDate!)}</strong>{sched.batch ? ` · lote ${sched.batch}` : ""}.</p>}
            {sched.warnings.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Avisos: {sched.warnings.map((w) => WARNING_LABEL[w]).join("; ")}.</p>}
          </div>
        )}
      </SectionCard>

      {sp.comissao && <Callout tone="positive" role="status">Comissão atualizada. Vale para os próximos fechamentos; os já fechados não mudam.</Callout>}
      {(c.commissionPartner && commRead) || commManage ? (
        <SectionCard title="Comissão de parceiro">
          {c.commissionPartner && commRead && <p className="mb-2 text-sm">Parceiro <strong>{c.commissionPartner}</strong> · {c.commissionBps ? <>percentual <strong>{percentLabel(c.commissionBps)}</strong> sobre o valor mensal</> : <span className="text-warning-foreground">percentual ainda não definido (fica fora do cálculo e impede o fechamento)</span>}.</p>}
          {commManage ? (
            <form action={commissionAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="contractId" value={c.id} />
              <div><label htmlFor="partner" className="block text-xs text-muted-foreground">Parceiro (vazio = sem comissão)</label><input id="partner" name="partner" maxLength={60} defaultValue={c.commissionPartner ?? ""} placeholder="Ex.: Medina" className={`${inputClass} max-w-[14rem]`} /></div>
              <div><label htmlFor="percent" className="block text-xs text-muted-foreground">Percentual (%)</label><input id="percent" name="percent" inputMode="decimal" defaultValue={c.commissionBps ? String(c.commissionBps / 100).replace(".", ",") : ""} placeholder="30" className={`${inputClass} max-w-[7rem]`} /></div>
              <button className={buttonClass("outline")}>Salvar comissão</button>
            </form>
          ) : null}
        </SectionCard>
      ) : null}

      {pending && (
        <SectionCard title={status === "rascunho" ? "Aprovação do contrato" : "Alteração aguardando aprovação"}>
          <p className="text-sm">Versão {pending.version}: {t(pending.terms)}</p>
          {pending.reason && <p className="text-sm text-muted-foreground">Motivo: {pending.reason}</p>}
          {approve ? (
            <form action={decideAction} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="contractId" value={c.id} /><input type="hidden" name="versionId" value={pending.id} />
              <label htmlFor="note" className="sr-only">Observação</label><input id="note" name="note" placeholder="Observação (opcional)" className={`${inputClass} max-w-xs`} />
              <button name="decision" value="aprovar" className={buttonClass("success")}>Aprovar</button>
              <button name="decision" value="rejeitar" className={buttonClass("danger")}>Rejeitar</button>
            </form>
          ) : <p className="mt-2 text-sm text-muted-foreground">Aguardando um gerente ou a diretoria. Quem solicitou não pode aprovar a própria alteração.</p>}
        </SectionCard>
      )}

      {write && status !== "encerrado" && (!pending || status === "rascunho") && (
        <SectionCard title={status === "rascunho" ? "Corrigir o contrato" : "Aditivo ou ajuste de valor"}>
          {tooBig && <Callout tone="warning" role="status">Esse percentual levaria o valor acima do máximo permitido para o contrato; informe o novo valor à mão.</Callout>}
          {proposed !== null && status !== "rascunho" && <Callout tone="info" role="status">Reajuste de <strong>{String(pctBps! / 100).replace(".", ",")}%</strong> sobre {formatBRL(c.amountCents)} = <strong>{formatBRL(proposed)}</strong>. Conferir e ajustar antes de enviar; nada muda até a aprovação.</Callout>}
          <p className="mb-3 text-sm text-muted-foreground">{status === "rascunho" ? "Ajuste os dados antes da aprovação." : "A alteração só passa a valer depois de aprovada; os termos atuais continuam até lá."}</p>
          <ContractForm action={proposeAction.bind(null, c.id)} withReason amendment={status !== "rascunho"} approveNow={status !== "rascunho" && role === "diretoria"} submit={status === "rascunho" ? "Salvar correção" : "Enviar para aprovação"}
            defaults={{ ...(proposed !== null && status !== "rascunho" ? { kind: "reajuste", reason: `Reajuste de ${String(pctBps! / 100).replace(".", ",")}%` } : {}), description: c.description, monthlyAmount: brMoney(proposed ?? c.amountCents), startAt: c.startAt, endAt: c.endAt, dueDay: c.dueDay, invoiceJointRequired: c.invoiceJointRequired, issueDayOverride: c.issueDayOverride }} />
        </SectionCard>
      )}

      {write && status !== "rascunho" && status !== "encerrado" && (
        <SectionCard title="Situação do contrato">
          <form action={statusAction} className="flex flex-wrap gap-2">
            <input type="hidden" name="contractId" value={c.id} />
            {status === "ativo" && <button name="to" value="suspenso" className={buttonClass("outline")}>Suspender</button>}
            {status === "suspenso" && approve && <button name="to" value="ativo" className={buttonClass("success")}>Reativar</button>}
            {status === "suspenso" && !approve && <p className="text-sm text-muted-foreground">Reativar exige gerente ou diretoria.</p>}
            <button name="to" value="encerrado" className={buttonClass("danger")}>Encerrar (definitivo)</button>
          </form>
        </SectionCard>
      )}

      {write && status !== "rascunho" && status !== "encerrado" && (
        <SectionCard title="Reajuste anual deste contrato">
          {sp.regra && <Callout tone="positive" role="status">Regra de reajuste salva.</Callout>}
          <p className="mb-3 text-sm text-muted-foreground">Registre o índice combinado no contrato. É só uma anotação: o sistema nunca reajusta sozinho, ele ajuda a pré-preencher o aditivo quando o alerta de reajuste chegar.</p>
          <form action={saveRuleAction} className="grid max-w-xl gap-3 sm:grid-cols-3">
            <input type="hidden" name="contractId" value={c.id} />
            <div><label htmlFor="rule-index" className="mb-1 block text-sm font-medium">Índice</label><select id="rule-index" name="index" defaultValue={rule?.indexCode ?? "ipca"} className={inputClass}>{INDEX_CODES.map((i) => <option key={i} value={i}>{INDEX_LABEL[i]}</option>)}</select></div>
            <div><label htmlFor="rule-pct" className="mb-1 block text-sm font-medium">Percentual fixo (%)</label><input id="rule-pct" name="fixedPct" inputMode="decimal" defaultValue={rule?.fixedBps != null ? String(rule.fixedBps / 100).replace(".", ",") : ""} placeholder="só para 'fixo'" className={inputClass} /></div>
            <div><label htmlFor="rule-note" className="mb-1 block text-sm font-medium">Observação</label><input id="rule-note" name="note" maxLength={200} defaultValue={rule?.note ?? ""} className={inputClass} /></div>
            <div className="sm:col-span-3"><button className={buttonClass("outline")}>Salvar regra</button></div>
          </form>
        </SectionCard>
      )}

      <SectionCard title="Histórico de versões">
        <ul className="space-y-3">
          {c.versions.map((v) => (
            <li key={v.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong>v{v.version}</strong><StatusPill tone={VTONE[v.state as keyof typeof VTONE]}>{v.state}</StatusPill>{v.version > 1 && <StatusPill tone="neutral">{KIND_LABEL[v.kind as AmendmentKind] ?? v.kind}</StatusPill>}<span className="text-muted-foreground">{formatDateTime(v.createdAt)}</span></div>
              <p>{t(v.terms)}</p>
              {v.reason && <p className="text-muted-foreground">Motivo: {v.reason}</p>}
              {(v.effectiveOn || v.reference) && <p className="text-muted-foreground">{v.effectiveOn ? `Vale a partir de ${formatDate(v.effectiveOn)}` : ""}{v.effectiveOn && v.reference ? " · " : ""}{v.reference ? `Documento: ${v.reference}` : ""}</p>}
              {v.state === "agendada" && approve && (
                <form action={cancelScheduleAction} className="mt-1 flex flex-wrap items-center gap-2"><input type="hidden" name="contractId" value={c.id} /><input type="hidden" name="versionId" value={v.id} /><input name="note" aria-label="Motivo do cancelamento" placeholder="Motivo (opcional)" maxLength={200} className={inputClass} /><button className={buttonClass("outline", "sm")}>Cancelar agendamento</button></form>
              )}
              {v.appliedAt && <p className="text-muted-foreground">Passou a valer em {formatDateTime(v.appliedAt)}</p>}
              {v.decidedAt && <p className="text-muted-foreground">Decidida em {formatDateTime(v.decidedAt)}{v.decisionNote ? ` — ${v.decisionNote}` : ""}</p>}
            </li>
          ))}
        </ul>
      </SectionCard>

      <NotesBlock notes={notes} action={noteAction} hidden={{ contractId: c.id }} canWrite={write} />
    </div>
  );
}
