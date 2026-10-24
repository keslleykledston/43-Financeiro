import Link from "next/link";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { getCustomerMode, getParty, history, STATUS_LABEL, type Status } from "@/modules/crm/service";
import { PartyForm } from "../party-form";
import { Tabs } from "@/components/k3g/tabs";
import { AddressForm, TextsForm } from "../extras-forms";
import { AddressView, TextsView, type Extras } from "../extras-view";
import { ContactForm } from "../contact-form";
import { archiveAction, noteAction, removeContactAction, updateAction } from "../actions";
import { listNotes } from "@/modules/notes/service";
import { NotesBlock } from "@/components/k3g/notes-block";

const LABEL: Record<string, string> = {
  "party.created": "Cadastro criado", "party.updated": "Dados alterados", "party.archived": "Arquivado", "party.restored": "Restaurado",
  "party.contact_added": "Contato adicionado", "party.contact_removed": "Contato removido",
};

export default async function Detalhe({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ salvo?: string; erro?: string; aba?: string }> }) {
  const [{ id }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  if (!ctx.current || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const role = await activeRole(db, ctx.user.id, ctx.current.id);
  if (!role || !can(role, "crm.read")) return <p className="rounded-lg border bg-card p-6">Seu papel não tem acesso a clientes e fornecedores.</p>;
  const p = await getParty(db, ctx.user.id, ctx.current.id, id); // filtrado por empresa: ID de outra empresa => null
  if (!p) notFound();
  const shown = (p as { displayName?: string | null }).displayName ?? p.legalName; // nome para mostrar (fantasia quando a razão social é só o número do CNPJ)
  const write = can(role, "crm.write");
  const crmMode = (await getCustomerMode(db, ctx.user.id, ctx.current.id)) === "crm";
  const crmOwned = p.source === "crm" && crmMode; // somente leitura só no modo CRM
  const notes = p.kind === "cliente" ? await listNotes(db, ctx.user.id, ctx.current.id, { customerId: id }) : [];
  const log = await history(db, ctx.user.id, ctx.current.id, id);
  const x = p as unknown as Extras;
  const dados = write && !p.archivedAt && !crmOwned ? (
    <PartyForm action={updateAction.bind(null, id)} defaults={{ kind: p.kind, status: p.status, legalName: p.legalName, tradeName: p.tradeName, document: p.documentFormatted }} submit="Salvar" lockKind />
  ) : (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Razão social / nome</dt><dd>{p.legalName}</dd></div>
      <div><dt className="text-muted-foreground">Nome fantasia</dt><dd>{p.tradeName ?? "—"}</dd></div>
      <div><dt className="text-muted-foreground">{p.docType.toUpperCase()}</dt><dd>{p.documentFormatted}</dd></div>
      <div><dt className="text-muted-foreground">Situação</dt><dd>{p.kind === "cliente" ? STATUS_LABEL[p.status as Status] : "—"}</dd></div>
      {crmOwned && <p className="text-xs text-muted-foreground sm:col-span-2">Estes dados vêm do CRM e não mudam aqui (a sincronização os sobrescreveria). Para corrigir razão social, CNPJ ou situação, edite no CRM. Endereço, textos, anotações e contatos abaixo são só daqui e podem ser editados.</p>}
    </dl>
  );
  const contatos = (
    <div>
      {p.contacts.length === 0 && <p className="text-sm text-muted-foreground">Nenhum contato. Adicione um contato financeiro para receber cobranças.</p>}
      <ul className="divide-y divide-border">
        {p.contacts.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="min-w-0"><p className="truncate font-medium">{c.name}{c.isFinancial && <span className="ml-2 rounded-full bg-info-soft px-2 py-0.5 text-xs text-info-foreground">Financeiro</span>}{c.source === "crm" && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">CRM</span>}</p><p className="truncate text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(" · ") || "sem e-mail/telefone"}</p></div>
            {write && !(c.source === "crm" && crmMode) && <form action={removeContactAction}><input type="hidden" name="contactId" value={c.id} /><input type="hidden" name="partyId" value={id} /><button className="rounded-lg px-3 py-1.5 text-negative-foreground ring-1 ring-negative/30">Remover</button></form>}
          </li>
        ))}
      </ul>
      {write && !p.archivedAt && <div className="mt-4 border-t border-border pt-4"><ContactForm partyId={id} /></div>}
    </div>
  );
  return (
    <div className="max-w-3xl space-y-5">
      <Link href="/clientes" className="text-sm text-primary">← Voltar</Link>
      <div>
        <h1 className="text-2xl font-semibold">{shown}</h1>
        <p className="text-sm text-muted-foreground">{p.kind === "cliente" ? "Cliente" : "Fornecedor"} · {p.docType.toUpperCase()} {p.documentFormatted}{shown !== p.legalName && <span> · razão social: {p.legalName}</span>}{p.archivedAt && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">Arquivado</span>}{p.kind === "cliente" && <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${p.status === "ativo" ? "bg-positive-soft text-positive-foreground" : p.status === "cancelado" ? "bg-negative-soft text-negative-foreground" : "bg-warning-soft text-warning-foreground"}`}>{STATUS_LABEL[p.status as Status]}</span>}</p>
      </div>
      {p.kind === "cliente" && p.status !== "ativo" && <p role="note" className="rounded-md bg-warning-soft p-3 text-sm text-warning-foreground">Cliente <strong>{p.status}</strong>: continua cadastrado (pode ter dívidas antigas a receber), mas <strong>não gera nova cobrança</strong>.</p>}
      {sp.erro && <p role="alert" className="rounded-md bg-negative-soft p-3 text-sm text-negative-foreground">{sp.erro}</p>}
      {sp.salvo && <p role="status" className="rounded-md bg-positive-soft p-3 text-sm text-positive-foreground">Alterações salvas.</p>}
      {crmOwned && <p role="note" className="rounded-md bg-info-soft p-3 text-sm text-info-foreground">Cadastro sincronizado do CRM (somente leitura). Para alterar dados ou arquivar, edite no CRM. Contatos adicionais locais são permitidos.</p>}
      {p.source === "crm" && !crmMode && <p role="note" className="rounded-md bg-warning-soft p-3 text-sm text-warning-foreground">Este cadastro veio do CRM, mas a empresa está no modo Local, então ele é editável. Se voltar ao modo CRM, os dados do CRM sobrescrevem suas edições.</p>}
      <section className="rounded-lg border bg-card p-5" aria-labelledby="editar-h">
        <h2 id="editar-h" className="mb-3 text-lg font-semibold">Editar</h2>
        <Tabs label="Edição do cadastro" initial={sp.aba} tabs={[
          { id: "dados", label: "Dados", content: dados },
          ...(p.kind === "cliente" ? [
            { id: "endereco", label: "Endereço", content: write && !p.archivedAt ? <AddressForm id={id} a={x} /> : <AddressView a={x} /> },
            { id: "nota-boleto", label: "Nota fiscal e boleto", content: write && !p.archivedAt ? <TextsForm id={id} nfText={x.nfText} boletoText={x.boletoText} /> : <TextsView nfText={x.nfText} boletoText={x.boletoText} /> },
            { id: "anotacoes", label: `Anotações (${notes.length})`, content: <NotesBlock notes={notes} action={noteAction} hidden={{ partyId: id }} canWrite={write} /> },
          ] : []),
          { id: "contatos", label: `Contatos (${p.contacts.length})`, content: contatos },
        ]} />
      </section>
      <section className="rounded-lg border bg-card p-5">
        <h2 className="mb-3 font-semibold">Histórico</h2>
        <ul className="space-y-1 text-sm text-muted-foreground">
          {log.map((h, i) => <li key={i}>{h.at.toLocaleString("pt-BR", { timeZone: "America/Manaus" })} — {LABEL[h.action] ?? h.action}</li>)}
        </ul>
      </section>
      {write && !crmOwned && (
        <form action={archiveAction}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="archived" value={p.archivedAt ? "0" : "1"} />
          <button className="rounded-md px-4 py-2.5 text-sm text-negative-foreground ring-1 ring-negative/30">{p.archivedAt ? "Restaurar cadastro" : "Arquivar cadastro"}</button>
        </form>
      )}
    </div>
  );
}
