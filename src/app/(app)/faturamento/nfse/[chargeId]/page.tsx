import { notFound } from "next/navigation";
import { ArrowLeft, FileCode2 } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { previewNfse } from "@/modules/nfse/preview";
import { Callout, Money, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";

export default async function PreviaNfse({ params }: { params: Promise<{ chargeId: string }> }) {
  const [{ chargeId }, ctx] = await Promise.all([params, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "billing.read")) return <Callout tone="warning">Seu papel não tem acesso às cobranças.</Callout>;
  const p = await previewNfse(db, ctx.user.id, ctx.current.id, chargeId);
  if (!p) notFound();
  return (
    <div className="space-y-5">
      <PageHeader title="Prévia da NFS-e" description={`${p.summary.customer} · competência ${p.summary.competence.slice(5, 7)}/${p.summary.competence.slice(0, 4)}`}
        actions={<AppLink href="/faturamento/lotes" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Lotes</AppLink>} />
      <Callout tone="info"><strong>Só uma prévia.</strong> Nada é emitido, assinado nem enviado à prefeitura. O arquivo abaixo mostra como a nota (NFS-e Padrão Nacional) seria montada com os dados cadastrados, em ambiente de <strong>homologação</strong>. A emissão real depende do certificado digital e da autorização escrita.</Callout>
      <SectionCard title="Resumo">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Prestador</dt><dd className="font-medium">{p.summary.company}</dd></div>
          <div><dt className="text-muted-foreground">Tomador (cliente)</dt><dd className="font-medium">{p.summary.customer}</dd></div>
          <div><dt className="text-muted-foreground">Valor do serviço</dt><dd className="font-medium"><Money cents={p.summary.amountCents} /></dd></div>
          <div className="sm:col-span-2"><dt className="text-muted-foreground">Descrição na nota</dt><dd className="whitespace-pre-wrap font-medium">{p.summary.description}</dd></div>
        </dl>
      </SectionCard>
      {!p.ready ? (
        <Callout tone="warning" role="alert"><strong>Ainda não dá para montar a nota.</strong> Falta ou está inválido:
          <ul className="mt-1 list-disc pl-5">{p.problems.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="mt-2 text-sm">Dados da empresa: <AppLink href="/empresa" className="underline">Configurações → Empresa</AppLink>. Dados do cliente: <AppLink href="/clientes" className="underline">Clientes</AppLink>.</p>
        </Callout>
      ) : (
        <>
          <Callout tone="positive" role="status"><strong>Dados completos.</strong> A DPS foi montada e passa na validação do leiaute oficial.</Callout>
          {p.warnings.map((w) => <Callout key={w} tone="warning">{w}</Callout>)}
          <SectionCard title="Arquivo da DPS (XML, sem assinatura)" action={<a href={`/faturamento/nfse/${p.chargeId}/xml`} className={buttonClass("outline")}><FileCode2 className="size-4" aria-hidden /> Baixar XML</a>}>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{p.xml}</pre>
          </SectionCard>
        </>
      )}
    </div>
  );
}
