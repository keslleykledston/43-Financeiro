import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listCategories, listCostCenters, listPartners } from "@/modules/expenses/catalog";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { SettingsTabs } from "@/components/k3g/settings-tabs";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { saveCategoryAction, saveCenterAction, savePartnerAction, toggleCategoryAction, toggleCenterAction, togglePartnerAction } from "./actions";

function Toggle({ action, id, active }: { action: (fd: FormData) => Promise<void>; id: string; active: boolean }) {
  return <form action={action}><input type="hidden" name="id" value={id} /><input type="hidden" name="active" value={active ? "0" : "1"} /><button className={buttonClass("ghost", "sm")}>{active ? "Desativar" : "Reativar"}</button></form>;
}
function Rename({ action, id, name, label }: { action: (fd: FormData) => Promise<void>; id: string; name: string; label: string }) {
  return <form action={action} className="flex gap-2"><input type="hidden" name="id" value={id} /><input name="name" defaultValue={name} required minLength={2} maxLength={80} aria-label={`${label}: ${name}`} className={inputClass} /><button className={buttonClass("outline", "sm")}>Salvar</button></form>;
}

export default async function DespesasCadastros({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !(can(role, "payables.manage") || can(role, "partners.manage"))) return <Callout tone="warning">Seu papel não pode alterar os cadastros de despesas.</Callout>;
  const [cats, centers, partners] = await Promise.all([listCategories(db, ctx.user.id, ctx.current.id, { all: true }), listCostCenters(db, ctx.user.id, ctx.current.id, { all: true }), can(role, "partners.read") ? listPartners(db, ctx.user.id, ctx.current.id, { all: true }) : Promise.resolve([])]);
  const groups = (kind: "empresa" | "pessoal") => [...new Set(cats.filter((c) => c.kind === kind).map((c) => c.grp))];
  return (
    <div className="space-y-5">
      <SettingsTabs role={role} current="despesas" />
      <PageHeader title="Cadastros de despesas" description={ctx.current.name} />
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok && <Callout tone="positive" role="status">Salvo.</Callout>}

      <SectionCard title="Sócios">
        <p className="mb-3 text-sm text-muted-foreground">Quem pode ter retiradas e despesas pagas do próprio bolso nesta empresa. O saldo de cada um fica em <strong>Sócios</strong> no menu.</p>
        <ul className="divide-y divide-border">
          {partners.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex items-center gap-2">{can(role, "partners.manage") ? <Rename action={savePartnerAction} id={p.id} name={p.name} label="Nome do sócio" /> : <span>{p.name}</span>}{!p.active && <StatusPill tone="neutral">inativo</StatusPill>}</div>
              {can(role, "partners.manage") && <Toggle action={togglePartnerAction} id={p.id} active={p.active} />}
            </li>
          ))}
          {partners.length === 0 && <li className="py-2 text-sm text-muted-foreground">Nenhum sócio cadastrado.</li>}
        </ul>
        {can(role, "partners.manage") && <form action={savePartnerAction} className="mt-3 flex gap-2"><label className="sr-only" htmlFor="new-partner">Nome do novo sócio</label><input id="new-partner" name="name" required minLength={2} maxLength={80} placeholder="Nome do sócio" className={inputClass} /><button className={buttonClass("primary")}>Adicionar sócio</button></form>}
      </SectionCard>

      <SectionCard title="Centros de custo">
        <p className="mb-3 text-sm text-muted-foreground">Separam gastos de áreas ou projetos dentro da empresa (ex.: um imóvel de expansão), para não distorcer o resultado da operação.</p>
        <ul className="divide-y divide-border">
          {centers.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex items-center gap-2">{can(role, "payables.manage") ? <Rename action={saveCenterAction} id={c.id} name={c.name} label="Nome do centro de custo" /> : <span>{c.name}</span>}{!c.active && <StatusPill tone="neutral">inativo</StatusPill>}</div>
              {can(role, "payables.manage") && c.code !== "operacao" && <Toggle action={toggleCenterAction} id={c.id} active={c.active} />}
            </li>
          ))}
        </ul>
        {can(role, "payables.manage") && <form action={saveCenterAction} className="mt-3 flex gap-2"><label className="sr-only" htmlFor="new-center">Nome do novo centro de custo</label><input id="new-center" name="name" required minLength={2} maxLength={60} placeholder="Ex.: K3G 2 — imóvel de expansão" className={inputClass} /><button className={buttonClass("primary")}>Adicionar centro</button></form>}
      </SectionCard>

      {(["empresa", "pessoal"] as const).map((kind) => (
        <SectionCard key={kind} title={kind === "empresa" ? "Categorias de despesa da empresa" : "Categorias de gasto pessoal dos sócios"}>
          <div className="space-y-4">
            {groups(kind).map((g) => (
              <div key={g}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</h3>
                <ul className="divide-y divide-border">
                  {cats.filter((c) => c.kind === kind && c.grp === g).map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                      <div className="flex items-center gap-2">{can(role, "payables.manage") ? <Rename action={saveCategoryAction} id={c.id} name={c.name} label="Nome da categoria" /> : <span>{c.name}</span>}{!c.active && <StatusPill tone="neutral">inativa</StatusPill>}</div>
                      {can(role, "payables.manage") && !c.code.startsWith("a_classificar") && <Toggle action={toggleCategoryAction} id={c.id} active={c.active} />}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {can(role, "payables.manage") && (
            <form action={saveCategoryAction} className="mt-4 flex flex-wrap gap-2"><input type="hidden" name="kind" value={kind} />
              <label className="sr-only" htmlFor={`new-cat-${kind}`}>Nome da nova categoria</label><input id={`new-cat-${kind}`} name="name" required minLength={2} maxLength={60} placeholder="Nova categoria" className={inputClass} />
              <label className="sr-only" htmlFor={`new-grp-${kind}`}>Grupo</label><select id={`new-grp-${kind}`} name="grp" className={selectClass}>{groups(kind).map((g) => <option key={g}>{g}</option>)}</select>
              <button className={buttonClass("primary")}>Adicionar categoria</button></form>
          )}
        </SectionCard>
      ))}
    </div>
  );
}
