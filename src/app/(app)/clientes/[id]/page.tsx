import Link from "next/link";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCustomerMode, getParty, history } from "@/modules/crm/service";
import { PartyForm } from "../party-form";
import { ContactForm } from "../contact-form";
import { archiveAction, removeContactAction, updateAction } from "../actions";

const LABEL: Record<string, string> = {
  "party.created": "Cadastro criado", "party.updated": "Dados alterados", "party.archived": "Arquivado", "party.restored": "Restaurado",
  "party.contact_added": "Contato adicionado", "party.contact_removed": "Contato removido",
};

export default async function Detalhe({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ salvo?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  if (!ctx.current || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const role = await activeRole(db, ctx.user.id, ctx.current.id);
  if (!role || !can(role, "crm.read")) return <p className="rounded-2xl bg-white p-6 shadow-sm">Seu papel não tem acesso a clientes e fornecedores.</p>;
  const p = await getParty(db, ctx.user.id, ctx.current.id, id); // filtrado por empresa: ID de outra empresa => null
  if (!p) notFound();
  const write = can(role, "crm.write");
  const crmMode = (await getCustomerMode(db, ctx.user.id, ctx.current.id)) === "crm";
  const crmOwned = p.source === "crm" && crmMode; // somente leitura só no modo CRM
  const log = await history(db, ctx.user.id, ctx.current.id, id);
  return (
    <div className="max-w-2xl space-y-5">
      <Link href="/clientes" className="text-sm text-blue-700">← Voltar</Link>
      <div>
        <h1 className="text-2xl font-semibold">{p.legalName}</h1>
        <p className="text-sm text-slate-600">{p.kind === "cliente" ? "Cliente" : "Fornecedor"} · {p.docType.toUpperCase()} {p.documentFormatted}{p.archivedAt && <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-xs">Arquivado</span>}</p>
      </div>
      {sp.salvo && <p role="status" className="rounded-xl bg-green-50 p-3 text-sm text-green-900">Alterações salvas.</p>}
      {crmOwned && <p role="note" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">Cadastro sincronizado do CRM (somente leitura). Para alterar dados ou arquivar, edite no CRM. Contatos adicionais locais são permitidos.</p>}
      {p.source === "crm" && !crmMode && <p role="note" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Este cadastro veio do CRM, mas a empresa está no modo Local, então ele é editável. Se voltar ao modo CRM, os dados do CRM sobrescrevem suas edições.</p>}
      {write && !p.archivedAt && !crmOwned && (
        <section className="rounded-2xl bg-white p-5 shadow-sm"><h2 className="mb-3 font-semibold">Dados</h2>
          <PartyForm action={updateAction.bind(null, id)} defaults={{ kind: p.kind, legalName: p.legalName, tradeName: p.tradeName, document: p.documentFormatted }} submit="Salvar" lockKind /></section>
      )}
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">Contatos ({p.contacts.length})</h2>
        {p.contacts.length === 0 && <p className="text-sm text-slate-500">Nenhum contato. Adicione um contato financeiro para receber cobranças.</p>}
        <ul className="divide-y divide-slate-100">
          {p.contacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0"><p className="truncate font-medium">{c.name}{c.isFinancial && <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">Financeiro</span>}{c.source === "crm" && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">CRM</span>}</p><p className="truncate text-slate-500">{[c.email, c.phone].filter(Boolean).join(" · ") || "sem e-mail/telefone"}</p></div>
              {write && !(c.source === "crm" && crmMode) && <form action={removeContactAction}><input type="hidden" name="contactId" value={c.id} /><input type="hidden" name="partyId" value={id} /><button className="rounded-lg px-3 py-1.5 text-red-700 ring-1 ring-red-200">Remover</button></form>}
            </li>
          ))}
        </ul>
        {write && !p.archivedAt && <div className="mt-4 border-t border-slate-100 pt-4"><ContactForm partyId={id} /></div>}
      </section>
      <section className="rounded-2xl bg-white p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">Histórico</h2>
        <ul className="space-y-1 text-sm text-slate-600">
          {log.map((h, i) => <li key={i}>{h.at.toLocaleString("pt-BR", { timeZone: "America/Manaus" })} — {LABEL[h.action] ?? h.action}</li>)}
        </ul>
      </section>
      {write && !crmOwned && (
        <form action={archiveAction}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="archived" value={p.archivedAt ? "0" : "1"} />
          <button className="rounded-xl px-4 py-2.5 text-sm text-red-700 ring-1 ring-red-200">{p.archivedAt ? "Restaurar cadastro" : "Arquivar cadastro"}</button>
        </form>
      )}
    </div>
  );
}
