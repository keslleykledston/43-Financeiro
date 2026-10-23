import { Hourglass } from "lucide-react";
import { PageHeader } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";

export default function Page() {
  return (
    <>
      <PageHeader title="Faturamento" description="Prévia e aprovação de lotes. Nenhuma emissão real está habilitada." />
      <EmptyState icon={Hourglass} title="Em construção" description="Próxima entrega: E05 — prévia e aprovação de lote. Esta tela já faz parte do menu e ganha conteúdo real quando a fase chegar." />
    </>
  );
}
