import { and, asc, eq } from "drizzle-orm";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listConsents } from "@/modules/whatsapp/service";
import { CONSENT_LABEL, EVIDENCE_LABEL, EVIDENCE_SOURCES, type ConsentState } from "@/modules/whatsapp/domain";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass } from "@/components/k3g/button";
import { ConsentForm } from "./form";

const TONE: Record<ConsentState, StatusTone> = { opt_in: "positive", opt_out_company: "negative", opt_out_global: "negative", none: "neutral" };

export default async function Consentimentos({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.consent")) return <Callout tone="warning">Seu papel não tem acesso aos consentimentos de WhatsApp.</Callout>;
  const [rows, cust] = await Promise.all([
    listConsents(db, ctx.user.id, ctx.current.id),
    db.select({ id: customers.id, name: customers.displayName }).from(customers).where(and(eq(customers.companyId, ctx.current.id), eq(customers.status, "ativo"))).orderBy(asc(customers.displayName)).limit(500),
  ]);
  return (
    <div className="space-y-5">
      <PageHeader title="Consentimentos de WhatsApp" description={`${ctx.current.name} · quem aceitou (ou pediu para parar) de receber avisos pelo WhatsApp.`} actions={<AppLink href="/whatsapp" className={buttonClass("outline")}>Conexões</AppLink>} />
      {sp.ok === "registrado" && <Callout tone="positive" role="status">Registrado. O pedido de parar vale na hora e prevalece sobre qualquer autorização.</Callout>}
      <Callout tone="info">Sem consentimento registrado, o sistema <strong>não envia cobrança</strong> por WhatsApp a ninguém. O pedido de parar <strong>sempre prevalece</strong>, nunca é desfeito sozinho e vale até um novo registro com prova. Cada empresa tem a sua lista: o consentimento dado à K3G Solutions não vale para a K3G Call.</Callout>
      <SectionCard title="Registrar"><ConsentForm customers={cust.map((c) => ({ id: c.id, name: c.name }))} sources={EVIDENCE_SOURCES.map((v) => ({ value: v, label: EVIDENCE_LABEL[v] }))} canGlobal={can(role, "whatsapp.authorize")} /></SectionCard>
      <SectionCard title="Situação atual dos contatos">
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum registro ainda.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="pb-2 pr-4 font-medium">Contato</th><th className="pb-2 pr-4 font-medium">Cliente</th><th className="pb-2 pr-4 font-medium">Situação</th><th className="pb-2 pr-4 font-medium">Prova</th><th className="pb-2 font-medium">Registrado</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.phone + r.at.toISOString()} className="border-t"><td className="py-2 pr-4">{r.phone}</td><td className="py-2 pr-4">{r.customer ?? "—"}</td>
                <td className="py-2 pr-4"><StatusPill tone={TONE[r.state]}>{CONSENT_LABEL[r.state]}</StatusPill></td><td className="py-2 pr-4 text-muted-foreground">{EVIDENCE_LABEL[r.source]}</td>
                <td className="py-2 text-muted-foreground">{r.at.toLocaleDateString("pt-BR", { timeZone: "America/Manaus" })}{r.actor ? ` · ${r.actor}` : ""}</td></tr>
            ))}</tbody></table></div>
        )}
      </SectionCard>
    </div>
  );
}
