import { Hourglass } from "lucide-react";
import { PageHeader } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";

export default function Page() {
  return (
    <>
      <PageHeader title="Conciliação" description="Importação de extratos e vínculo com cobranças." />
      <EmptyState icon={Hourglass} title="Em construção" description="Próxima entrega: E08 — conciliação. Esta tela já faz parte do menu e ganha conteúdo real quando a fase chegar." />
    </>
  );
}
