import Link from "next/link";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCustomerMode } from "@/modules/crm/service";
import { PartyForm } from "../party-form";
import { createAction } from "../actions";

export default async function Novo() {
  const ctx = await requireContext();
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!role || !can(role, "crm.write")) return <p className="rounded-2xl bg-white p-6 shadow-sm">Seu papel não permite cadastrar.</p>;
  const crm = (await getCustomerMode(db, ctx.user.id, ctx.current!.id)) === "crm";
  return (
    <div className="max-w-xl space-y-4">
      <Link href="/clientes" className="text-sm text-blue-700">← Voltar</Link>
      <h1 className="text-2xl font-semibold">Novo cadastro</h1>
      {crm && <p role="note" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">Nesta empresa os <strong>clientes</strong> vêm do CRM. Aqui você cadastra apenas <strong>fornecedores</strong>.</p>}
      <section className="rounded-2xl bg-white p-5 shadow-sm"><PartyForm action={createAction} submit="Cadastrar" onlyVendor={crm} /></section>
    </div>
  );
}
