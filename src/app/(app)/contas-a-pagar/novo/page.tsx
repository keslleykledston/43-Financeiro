import { ArrowLeft } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listActiveVendors } from "@/modules/payables/service";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { PayableForm } from "../payable-form";

export default async function NovaConta() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.write")) return <Callout tone="warning">Seu papel não pode lançar contas a pagar.</Callout>;
  const vendors = await listActiveVendors(db, ctx.user.id, ctx.current.id);
  return (
    <div className="space-y-5">
      <PageHeader title="Nova conta a pagar" description={ctx.current.name} actions={<AppLink href="/contas-a-pagar" className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Contas a pagar</AppLink>} />
      <Callout tone="info">O lançamento começa como <strong>rascunho</strong>. Depois de enviado, quem tem alçada aprova. O pagamento em si é feito no banco, fora do sistema.</Callout>
      <SectionCard title="Dados da conta">
        {vendors.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum fornecedor ativo. <AppLink href="/clientes/novo" className="underline">Cadastre o fornecedor</AppLink> (tipo “Fornecedor”) e volte aqui.</p> : <PayableForm vendors={vendors} />}
      </SectionCard>
    </div>
  );
}
