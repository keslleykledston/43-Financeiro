import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { previewAction } from "../../../actions";

export default async function Importar({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "bank.import")) return <Callout tone="warning">Seu papel não pode importar extratos.</Callout>;
  return (
    <div className="space-y-5">
      <PageHeader title="Importar extrato" description={ctx.current.name} actions={<AppLink href={`/conciliacao/contas/${id}`} className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Conta</AppLink>} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      <Callout tone="info">Nada é gravado ainda: primeiro você vê uma <strong>prévia</strong> (novas × repetidas, período e conferência de saldo) e só então confirma.</Callout>
      <SectionCard title="Arquivo">
        <form action={previewAction} className="max-w-xl space-y-4">
          <input type="hidden" name="accountId" value={id} />
          <div><label htmlFor="file" className="mb-1 block text-sm font-medium">Extrato (OFX ou CSV, até 2 MB)</label><input id="file" name="file" type="file" accept=".ofx,.csv,.txt,text/csv,application/x-ofx" required className={inputClass} /></div>
          <button className={buttonClass("primary")}>Analisar arquivo</button>
        </form>
        <div className="mt-4 space-y-1 text-xs text-muted-foreground">
          <p><strong>OFX</strong> é o formato mais seguro (traz identificador de cada lançamento e, geralmente, o saldo para conferência).</p>
          <p><strong>CSV genérico:</strong> colunas <code>Data; Descrição; Valor</code> (ou <code>Crédito</code> e <code>Débito</code>) e, se houver, <code>Id</code>. <a href="/conciliacao/modelo-csv" className="underline">Baixar modelo</a>. O layout de cada banco precisa ser validado com um arquivo real antes de depender dele.</p>
        </div>
      </SectionCard>
    </div>
  );
}
