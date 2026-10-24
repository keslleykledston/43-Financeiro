import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCompanyProfile } from "@/modules/companies/service";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { CompanyForm } from "./company-form";

export default async function Empresa() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "company.manage")) return <Callout tone="warning">Só a diretoria edita os dados da empresa.</Callout>;
  const p = await getCompanyProfile(db, ctx.user.id, ctx.current.id);
  return (
    <div className="max-w-2xl space-y-5">
      <AppLink href="/configuracao" className="text-sm text-primary">← Ajustes</AppLink>
      <PageHeader title="Dados da empresa" description={`Cadastro de ${ctx.current.name}. Cada alteração fica no registro de atividades.`} />
      <SectionCard title="Cadastro"><CompanyForm profile={{ name: p.name, legalName: p.legalName, cnpj: p.cnpjFormatted, financeEmail: p.financeEmail, address: p.address }} /></SectionCard>
    </div>
  );
}
