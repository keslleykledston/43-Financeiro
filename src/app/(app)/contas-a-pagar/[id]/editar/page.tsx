import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getPayable, listActiveVendors } from "@/modules/payables/service";
import { listCategories, listCostCenters } from "@/modules/expenses/catalog";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { PayableForm } from "../../payable-form";

export default async function EditarConta({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, ctx] = await Promise.all([params, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "payables.write")) return <Callout tone="warning">Seu papel não pode editar contas a pagar.</Callout>;
  const p = await getPayable(db, ctx.user.id, ctx.current.id, id);
  if (!p) notFound();
  if (p.status !== "rascunho") return <Callout tone="warning">Só rascunhos podem ser editados. Para corrigir uma conta enviada, cancele e lance de novo.</Callout>;
  const [vendors, categories, centers] = await Promise.all([listActiveVendors(db, ctx.user.id, ctx.current.id), listCategories(db, ctx.user.id, ctx.current.id, { kind: "empresa" }), listCostCenters(db, ctx.user.id, ctx.current.id)]);
  return (
    <div className="space-y-5">
      <PageHeader title="Editar rascunho" description={p.vendorName} actions={<AppLink href={`/contas-a-pagar/${id}`} className={buttonClass("outline")}><ArrowLeft className="size-4" aria-hidden /> Voltar</AppLink>} />
      <SectionCard title="Dados da conta"><PayableForm vendors={vendors} categories={categories} centers={centers} initial={{ id, vendorId: p.vendorId, description: p.description, documentNumber: p.documentNumber ?? "", amount: (p.amountCents / 100).toFixed(2).replace(".", ","), dueDate: p.dueDate, category: p.category ?? "", categoryId: p.categoryId ?? "", costCenterId: p.costCenterId ?? "", competence: p.competence ? p.competence.slice(0, 7) : "" }} /></SectionCard>
    </div>
  );
}
