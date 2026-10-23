import { requireContext } from "@/lib/security/context";
import { PageHeader, SectionCard } from "@/components/k3g/primitives";
import { PasswordForm } from "./password-form";

export default async function Conta() {
  const ctx = await requireContext();
  return (
    <div className="space-y-5">
      <PageHeader title="Minha conta" description={ctx.user.email ?? undefined} />
      <SectionCard title="Trocar senha"><PasswordForm /></SectionCard>
    </div>
  );
}
