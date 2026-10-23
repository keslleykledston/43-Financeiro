import Link from "next/link";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { CSV_TEMPLATE } from "@/modules/crm/service";
import { ImportForm } from "./import-form";

export default async function Importar() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!role || !can(role, "crm.write")) return <p className="rounded-2xl bg-white p-6 shadow-sm">Seu papel não permite importar.</p>;
  return (
    <div className="max-w-2xl space-y-4">
      <Link href="/clientes" className="text-sm text-blue-700">← Voltar</Link>
      <h1 className="text-2xl font-semibold">Importar clientes e fornecedores</h1>
      <section className="rounded-2xl bg-white p-5 text-sm shadow-sm">
        <p>Colunas (separador <code>;</code> ou <code>,</code>): <code>tipo</code> (cliente/fornecedor), <code>razao_social</code>, <code>nome_fantasia</code>, <code>documento</code>, <code>email_financeiro</code>, <code>telefone</code>. Máximo 1000 linhas / 500 KB.</p>
        <details className="mt-2"><summary className="cursor-pointer text-blue-700">Ver modelo</summary><pre className="mt-2 overflow-auto rounded-xl bg-slate-50 p-3">{CSV_TEMPLATE}</pre></details>
      </section>
      <ImportForm />
    </div>
  );
}
