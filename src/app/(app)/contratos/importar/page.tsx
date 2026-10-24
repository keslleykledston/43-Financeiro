import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { CONTRACT_IMPORT_TEMPLATE, listImports } from "@/modules/contracts/import";
import { formatDateTime } from "@/lib/format";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { ImportForm } from "./import-form";

export default async function Importar() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.write")) return <Callout tone="warning">Seu papel não permite importar contratos.</Callout>;
  const lotes = await listImports(db, ctx.user.id, ctx.current.id);
  return (
    <div className="max-w-3xl space-y-5">
      <AppLink href="/contratos" className="text-sm text-primary">← Contratos</AppLink>
      <PageHeader title="Importar contratos" description={`${ctx.current.name} · um contrato por linha; cria rascunhos que outra pessoa aprova de uma vez.`} />
      <SectionCard title="Como funciona">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Converta a planilha de boletos em CSV (o conversor roda no servidor, fora do site) ou monte o CSV à mão no modelo abaixo.</li>
          <li>Envie o arquivo e confira a prévia: nada é gravado até você confirmar.</li>
          <li>Os contratos nascem como <strong>rascunho</strong>. Outra pessoa (gerente ou diretoria) aprova o lote inteiro na tela do lote.</li>
        </ol>
        <p className="mt-3 text-sm text-muted-foreground">Colunas obrigatórias: <code>razao_social</code>, <code>documento</code>, <code>servico</code>, <code>valor_mensal</code>, <code>dia_vencimento</code>, <code>inicio</code>. Opcionais: <code>fim</code>, <code>email_financeiro</code>, <code>contato</code>, <code>parceiro_comissao</code>. Máximo 1000 linhas / 500 KB. Cliente do CRM é encontrado pelo CNPJ/CPF; se a empresa usa cadastro local, o cliente que faltar é criado.</p>
        <details className="mt-2 text-sm"><summary className="cursor-pointer text-primary">Ver modelo</summary><pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">{CONTRACT_IMPORT_TEMPLATE}</pre></details>
      </SectionCard>
      <ImportForm />
      {lotes.length > 0 && (
        <SectionCard title="Lotes anteriores">
          <ul className="divide-y divide-border text-sm">
            {lotes.map((l) => (
              <li key={l.id}>
                <AppLink href={`/contratos/importar/${l.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-accent">
                  <span>{formatDateTime(l.createdAt)} · {l.summary.contracts} contrato(s)</span>
                  <span className="flex gap-2">
                    {l.byStatus.rascunho ? <StatusPill tone="info">{l.byStatus.rascunho} aguardando</StatusPill> : null}
                    {l.byStatus.ativo ? <StatusPill tone="positive">{l.byStatus.ativo} ativos</StatusPill> : null}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
