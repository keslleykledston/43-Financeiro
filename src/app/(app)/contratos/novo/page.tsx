import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { customerOptions } from "@/modules/contracts/service";
import { PageHeader, SectionCard, Callout } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { ContractForm } from "../contract-form";
import { createAction } from "../actions";

export default async function Novo() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "contracts.write")) return <Callout tone="warning">Seu papel não permite cadastrar contratos.</Callout>;
  const customers = await customerOptions(db, ctx.user.id, ctx.current.id);
  return (
    <div className="max-w-2xl space-y-4">
      <AppLink href="/contratos" className="text-sm text-primary">← Voltar</AppLink>
      <PageHeader title="Novo contrato" description="O contrato nasce como rascunho e só passa a gerar cobrança depois de aprovado por gerente ou diretoria." />
      <SectionCard><ContractForm action={createAction} customers={customers} submit="Criar e enviar para aprovação" withReason /></SectionCard>
    </div>
  );
}
