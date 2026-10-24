import { ScrollText } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listAudit, listAuditActors } from "@/modules/identity/audit";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { EmptyState } from "@/components/k3g/states";
import { AppLink } from "@/components/k3g/app-link";
import { SettingsTabs } from "@/components/k3g/settings-tabs";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";

type SP = { q?: string; quem?: string; de?: string; ate?: string; p?: string };
const when = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "America/Manaus", dateStyle: "short", timeStyle: "short" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Auditoria({ searchParams }: { searchParams: Promise<SP> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "audit.read")) return <Callout tone="warning">Seu papel não tem acesso ao registro de atividades.</Callout>;
  const day = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
  const f = { action: sp.q?.slice(0, 60), actorId: sp.quem && UUID.test(sp.quem) ? sp.quem : undefined, from: day(sp.de), to: day(sp.ate), page: Number(sp.p) || 1 };
  const [res, actors] = await Promise.all([listAudit(db, ctx.user.id, ctx.current.id, f), listAuditActors(db, ctx.user.id, ctx.current.id)]);
  const link = (page: number) => `/auditoria?${new URLSearchParams(Object.entries({ q: sp.q ?? "", quem: f.actorId ?? "", de: f.from ?? "", ate: f.to ?? "", p: String(page) }).filter(([, v]) => v))}`;

  return (
    <div className="space-y-5">
      <SettingsTabs role={role} current="atividades" />
      <PageHeader title="Registro de atividades" description={`${ctx.current.name} · quem fez o quê e quando. Guarda só identificadores e contagens, nunca senhas ou valores sigilosos.`} />
      <SectionCard title="Atividades">
        <form method="get" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div><label htmlFor="q" className="mb-1 block text-xs font-medium">Tipo de ação (começa com)</label><input id="q" name="q" defaultValue={sp.q ?? ""} maxLength={60} placeholder="ex.: contract, auth" className={inputClass} /></div>
          <div><label htmlFor="quem" className="mb-1 block text-xs font-medium">Quem</label>
            <select id="quem" name="quem" defaultValue={f.actorId ?? ""} className={`${selectClass} w-full`}><option value="">Todos</option>{actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
          <div><label htmlFor="de" className="mb-1 block text-xs font-medium">De</label><input id="de" name="de" type="date" defaultValue={f.from ?? ""} className={inputClass} /></div>
          <div><label htmlFor="ate" className="mb-1 block text-xs font-medium">Até</label><input id="ate" name="ate" type="date" defaultValue={f.to ?? ""} className={inputClass} /></div>
          <div className="flex items-end gap-2"><button className={buttonClass("primary", "sm")}>Filtrar</button><AppLink href="/auditoria" className={buttonClass("ghost", "sm")}>Limpar</AppLink></div>
        </form>
        {res.rows.length === 0 ? (
          <EmptyState icon={ScrollText} title="Nenhuma atividade neste filtro" description="Mude o filtro ou o período." />
        ) : (
          <ul className="divide-y divide-border" aria-label="Atividades">
            {res.rows.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="font-medium">{r.label}</span><span className="text-xs text-muted-foreground">{when(r.at)}</span></div>
                <p className="text-xs text-muted-foreground">{r.who}{r.label !== r.action && <> · <code>{r.action}</code></>}{r.summary && <> · {r.summary}</>}</p>
              </li>
            ))}
          </ul>
        )}
        <nav aria-label="Páginas" className="mt-4 flex items-center justify-between text-sm">
          {res.page > 1 ? <AppLink href={link(res.page - 1)} className={buttonClass("outline", "sm")}>← Mais recentes</AppLink> : <span />}
          <span className="text-xs text-muted-foreground">Página {res.page}</span>
          {res.hasNext ? <AppLink href={link(res.page + 1)} className={buttonClass("outline", "sm")}>Mais antigas →</AppLink> : <span />}
        </nav>
      </SectionCard>
    </div>
  );
}
