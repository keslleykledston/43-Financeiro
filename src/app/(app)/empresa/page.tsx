import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCompanyProfile } from "@/modules/companies/service";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { CompanyForm } from "./company-form";
import { FiscalForm } from "./fiscal-form";
import { fiscalPending, getFiscalProfile } from "@/modules/companies/fiscal";

export default async function Empresa() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "company.manage")) return <Callout tone="warning">Só a diretoria edita os dados da empresa.</Callout>;
  const p = await getCompanyProfile(db, ctx.user.id, ctx.current.id);
  const fiscal = await getFiscalProfile(db, ctx.user.id, ctx.current.id);
  const pend = fiscalPending(fiscal);
  return (
    <div className="max-w-2xl space-y-5">
      <AppLink href="/configuracao" className="text-sm text-primary">← Ajustes</AppLink>
      <PageHeader title="Dados da empresa" description={`Cadastro de ${ctx.current.name}. Cada alteração fica no registro de atividades.`} />
      <SectionCard title="Cadastro"><CompanyForm profile={{ name: p.name, legalName: p.legalName, cnpj: p.cnpjFormatted, financeEmail: p.financeEmail, address: p.address }} /></SectionCard>
      <SectionCard title="Contabilidade e dados fiscais">
        {pend.nfse.length === 0 && pend.accounting.length === 0
          ? <Callout tone="positive">Tudo preenchido: a empresa está pronta, do lado dos dados, para a NFS-e. A emissão continua desligada até a fase própria.</Callout>
          : <Callout tone="warning">
              {pend.nfse.length > 0 && <p><strong>Falta para a NFS-e:</strong> {pend.nfse.join(", ")}.</p>}
              {pend.accounting.length > 0 && <p><strong>Falta da contabilidade:</strong> {pend.accounting.join(", ")}.</p>}
            </Callout>}
        <div className="mt-4"><FiscalForm v={fiscal} /></div>
      </SectionCard>
    </div>
  );
}
