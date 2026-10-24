import { BellRing } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { todayManaus } from "@/modules/messaging/service";
import { ALERT_LABEL, DEFAULT_WINDOW, WINDOWS, listContractAlerts, type AlertKind } from "@/modules/contracts/alerts";
import { Callout, Money, PageHeader, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, selectClass } from "@/components/k3g/button";
import { formatDate } from "@/lib/format";

const TONE: Record<AlertKind, StatusTone> = { vigencia_encerrada: "negative", reajuste_atrasado: "warning", vigencia_proxima: "warning", renovacao_proxima: "info", reajuste_proximo: "info" };
const plural = (n: number) => `${n} dia${n === 1 ? "" : "s"}`;

export default async function Alertas({ searchParams }: { searchParams: Promise<{ janela?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.read")) return <Callout tone="warning">Seu papel não tem acesso a contratos.</Callout>;
  const janela = WINDOWS.find((w) => String(w) === sp.janela) ?? DEFAULT_WINDOW;
  const { alerts, checked } = await listContractAlerts(db, ctx.user.id, ctx.current.id, todayManaus(), janela);
  const detail = (a: (typeof alerts)[number]) => {
    switch (a.kind) {
      case "vigencia_encerrada": return `A data final informada (${formatDate(a.date)}, há ${plural(a.days)}) já passou e o contrato continua ativo: já não gera cobrança. Encerre o contrato ou remova a data final se ele segue renovando.`;
      case "vigencia_proxima": return `Data final informada: ${formatDate(a.date)} (em ${plural(a.days)}). Depois dela o contrato deixa de renovar e de cobrar.`;
      case "renovacao_proxima": return `Renova sozinho em ${formatDate(a.date)} (${a.days === 0 ? "hoje" : `em ${plural(a.days)}`}) por mais 12 meses, se o cliente não se manifestar.${a.withAdjustment ? " É também o momento do reajuste: ainda sem novo valor aprovado." : ""}`;
      case "reajuste_atrasado": return `Fez 12 meses em ${formatDate(a.date)} (há ${plural(a.days)}) desde ${formatDate(a.since!)}, sem novo valor aprovado.`;
      case "reajuste_proximo": return `Faz 12 meses em ${formatDate(a.date)} (em ${plural(a.days)}), contando de ${formatDate(a.since!)}.`;
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Alertas de contratos" description={`${ctx.current.name} · ${checked} contrato(s) ativo(s) ou suspenso(s) conferidos. Só avisa: nada é alterado sozinho.`}
        actions={<AppLink href="/contratos" className={buttonClass("outline")}>← Contratos</AppLink>} />
      <form className="flex flex-wrap items-center gap-2" role="search">
        <label htmlFor="janela" className="text-sm text-muted-foreground">Avisar com antecedência de</label>
        <select id="janela" name="janela" defaultValue={String(janela)} className={selectClass}>{WINDOWS.map((w) => <option key={w} value={w}>{w} dias</option>)}</select>
        <button className={buttonClass("outline")}>Aplicar</button>
      </form>
      {alerts.length === 0 ? (
        <EmptyState icon={BellRing} title="Nenhum alerta" description={`Nenhum contrato renova, termina ou faz 12 meses nos próximos ${janela} dias.`} />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card">
          {alerts.map((a) => (
            <li key={`${a.contractId}-${a.kind}`}>
              <AppLink href={`/contratos/${a.contractId}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-accent">
                <div className="min-w-0"><p className="truncate font-medium">{a.customerName}</p><p className="text-sm text-muted-foreground">{detail(a)}</p></div>
                <div className="flex items-center gap-2"><StatusPill tone={TONE[a.kind]}>{ALERT_LABEL[a.kind]}</StatusPill><Money cents={a.amountCents} className="text-sm font-semibold" /></div>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Todo contrato vale 12 meses e renova sozinho se o cliente não se manifestar; só tem data final quando o cliente (ou a K3G) encerra. O reajuste conta 12 meses desde o início da vigência ou desde a última aprovação que mudou o valor. Para reajustar, abra o contrato e proponha o novo valor (a alteração passa por aprovação).</p>
    </div>
  );
}
