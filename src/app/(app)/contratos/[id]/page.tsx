import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getContract, STATUS_LABEL, type ContractStatus, type Terms } from "@/modules/contracts/service";
import { billingSchedule, WARNING_LABEL } from "@/modules/billing/calendar";
import { formatBRL, formatDate, formatDateTime } from "@/lib/format";
import { Callout, Money, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { ContractForm } from "../contract-form";
import { decideAction, proposeAction, statusAction } from "../actions";

const TONE: Record<ContractStatus, StatusTone> = { rascunho: "info", ativo: "positive", suspenso: "warning", encerrado: "neutral" };
const VTONE = { pendente: "info", aprovada: "positive", rejeitada: "negative", substituida: "neutral" } as const;
const brMoney = (c: number) => (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // 250000 → "2.500,00" (aceito pelo parser estrito)

export default async function Detalhe({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; proposta?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.read")) return <Callout tone="warning">Seu papel não tem acesso a contratos.</Callout>;
  const c = await getContract(db, ctx.user.id, ctx.current.id, id);
  if (!c) notFound();
  const write = can(role, "contracts.write"), approve = can(role, "contracts.approve");
  const pending = c.versions.find((v) => v.state === "pendente");
  const nextComp = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Manaus" }).slice(0, 7);
  const sched = billingSchedule({ competenceMonth: nextComp, dueDay: c.dueDay, jointInvoice: c.invoiceJointRequired, issueDayOverride: c.issueDayOverride });
  const status = c.status as ContractStatus;
  const t = (v: Terms) => `${formatBRL(v.monthlyAmountCents)} · vence dia ${v.dueDay} · ${v.invoiceJointRequired ? "NF junto" : "NF separada"} · ${formatDate(v.startAt)}${v.endAt ? ` a ${formatDate(v.endAt)}` : " (sem fim)"}`;
  return (
    <div className="max-w-3xl space-y-5">
      <AppLink href="/contratos" className="text-sm text-primary">← Voltar</AppLink>
      <PageHeader title={c.customer.legalName} description={`${c.description}`} actions={<StatusPill tone={TONE[status]}>{STATUS_LABEL[status]}</StatusPill>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.proposta && <Callout tone="positive" role="status">Alteração enviada para aprovação. Os termos vigentes continuam os mesmos até lá.</Callout>}
      {c.customer.status !== "ativo" && <Callout tone="warning">Cliente <strong>{c.customer.status}</strong>: este contrato não gera cobrança enquanto o cliente não voltar a ser ativo.</Callout>}

      <SectionCard title="Termos vigentes">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Valor mensal</dt><dd className="font-semibold"><Money cents={c.amountCents} /></dd></div>
          <div><dt className="text-muted-foreground">Vencimento</dt><dd>dia {c.dueDay} (competência M, vence em M+1)</dd></div>
          {c.commissionPartner && <div><dt className="text-muted-foreground">Parceiro com comissão</dt><dd>{c.commissionPartner}</dd></div>}
          <div><dt className="text-muted-foreground">Vigência</dt><dd>{formatDate(c.startAt)}{c.endAt ? ` a ${formatDate(c.endAt)}` : " · sem data final"}</dd></div>
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
        <SectionCard title={status === "rascunho" ? "Corrigir o contrato" : "Propor alteração"}>
          <p className="mb-3 text-sm text-muted-foreground">{status === "rascunho" ? "Ajuste os dados antes da aprovação." : "A alteração só passa a valer depois de aprovada; os termos atuais continuam até lá."}</p>
          <ContractForm action={proposeAction.bind(null, c.id)} withReason submit={status === "rascunho" ? "Salvar correção" : "Enviar para aprovação"}
            defaults={{ description: c.description, monthlyAmount: brMoney(c.amountCents), startAt: c.startAt, endAt: c.endAt, dueDay: c.dueDay, invoiceJointRequired: c.invoiceJointRequired, issueDayOverride: c.issueDayOverride }} />
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

      <SectionCard title="Histórico de versões">
        <ul className="space-y-3">
          {c.versions.map((v) => (
            <li key={v.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong>v{v.version}</strong><StatusPill tone={VTONE[v.state as keyof typeof VTONE]}>{v.state}</StatusPill><span className="text-muted-foreground">{formatDateTime(v.createdAt)}</span></div>
              <p>{t(v.terms)}</p>
              {v.reason && <p className="text-muted-foreground">Motivo: {v.reason}</p>}
              {v.decidedAt && <p className="text-muted-foreground">Decidida em {formatDateTime(v.decidedAt)}{v.decisionNote ? ` — ${v.decisionNote}` : ""}</p>}
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
