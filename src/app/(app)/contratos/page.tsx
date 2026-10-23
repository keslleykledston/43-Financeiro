import { Hourglass } from "lucide-react";
import { PageHeader } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";

export default function Page() {
  return (
    <>
      <PageHeader title="Contratos" description="Contratos mensais pós-pagos e calendário de lotes (25/1/8/15)." />
      <EmptyState icon={Hourglass} title="Em construção" description="Próxima entrega: E04 — contratos e calendário. Esta tela já faz parte do menu e ganha conteúdo real quando a fase chegar." />
    </>
  );
}
