import { Hourglass } from "lucide-react";
import { PageHeader } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";

export default function Page() {
  return (
    <>
      <PageHeader title="Contas a receber" description="Cobranças por competência e vencimento." />
      <EmptyState icon={Hourglass} title="Em construção" description="Próxima entrega: E07 — contas a receber. Esta tela já faz parte do menu e ganha conteúdo real quando a fase chegar." />
    </>
  );
}
