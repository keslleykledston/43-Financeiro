import { randomUUID } from "node:crypto";
import { CheckCircle2, XCircle } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { evaluateCustomerSend, whatsappTemplateOptions } from "@/modules/whatsapp/outbound";
import { listSessions } from "@/modules/whatsapp/service";
import { KIND_LABEL, type QueueKind } from "@/modules/messaging/templates";
import { Callout, PageHeader, SectionCard } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, selectClass } from "@/components/k3g/button";
import { QueueForm } from "./form";

export default async function EnviarWhatsApp({ searchParams }: { searchParams: Promise<{ chargeId?: string; templateVersionId?: string; sessionId?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.send")) return <Callout tone="warning">Seu papel não pode enviar cobranças por WhatsApp.</Callout>;
  const chargeId = String(sp.chargeId ?? "").slice(0, 40);
  const [templates, sessions] = await Promise.all([whatsappTemplateOptions(db, ctx.user.id, ctx.current.id), listSessions(db, ctx.user.id, ctx.current.id)]);
  const usable = templates.filter((t) => t.usable);
  const templateVersionId = String(sp.templateVersionId ?? usable[0]?.versionId ?? "").slice(0, 40);
  const sessionId = String(sp.sessionId ?? sessions.find((s) => s.status === "CONNECTED")?.id ?? sessions[0]?.id ?? "").slice(0, 40);
  const ev = chargeId && templateVersionId && sessionId ? await evaluateCustomerSend(db, ctx.user.id, ctx.current.id, { chargeId, templateVersionId, sessionId }) : null;
  const key = randomUUID().replace(/-/g, ""); // um por exibição: reenviar o MESMO formulário não duplica

  return (
    <div className="space-y-5">
      <PageHeader title="Cobrança por WhatsApp" description={`${ctx.current.name} · uma mensagem por vez, revisada por você.`} actions={<><AppLink href="/whatsapp/historico" className={buttonClass("outline")}>Histórico</AppLink><AppLink href="/contas-a-receber" className={buttonClass("outline")}>Contas a receber</AppLink></>} />
      <Callout tone="info">Aqui você <strong>coloca na fila</strong> uma mensagem para <strong>uma cobrança</strong>. Ela só sai quando você clicar em <strong>Enviar</strong> no histórico, e o sistema <strong>revalida tudo na hora</strong> (cobrança ainda devida, consentimento, janela, limites, conexão). Nada é automático.</Callout>
      {!chargeId ? <Callout tone="warning">Abra uma cobrança em <AppLink href="/contas-a-receber" className="underline">Contas a receber</AppLink> e use «Enviar por WhatsApp».</Callout> : (
        <>
          <SectionCard title="1. Modelo e conexão">
            <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <input type="hidden" name="chargeId" value={chargeId} />
              <div><label htmlFor="tpl" className="mb-1 block text-sm font-medium">Modelo</label>
                <select id="tpl" name="templateVersionId" defaultValue={templateVersionId} className={`${selectClass} w-full`}>{templates.map((t) => <option key={t.versionId} value={t.versionId} disabled={!t.usable}>{KIND_LABEL[t.kind as QueueKind]}{t.usable ? "" : " — indisponível"}</option>)}</select></div>
              <div><label htmlFor="ses" className="mb-1 block text-sm font-medium">Conexão</label>
                <select id="ses" name="sessionId" defaultValue={sessionId} className={`${selectClass} w-full`}>{sessions.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select></div>
              <button className={buttonClass("outline")}>Conferir</button>
            </form>
            {templates.length === 0 && <p className="mt-3 text-sm text-muted-foreground">Nenhum modelo de WhatsApp ativo. Crie em <AppLink href="/whatsapp/configuracao" className="underline">WhatsApp → Configuração</AppLink>.</p>}
          </SectionCard>
          {ev && (
            <SectionCard title="2. Prévia e lista de verificação">
              {ev.preview?.text ? (
                <div className="mb-4 rounded-md border bg-muted/40 p-3 text-sm">
                  <p className="mb-1 text-xs text-muted-foreground">Para {ev.preview.customer}{ev.preview.phoneMasked ? ` · ${ev.preview.phoneMasked}` : ""}</p>
                  <p className="whitespace-pre-wrap" data-testid="wa-preview">{ev.preview.text}</p>
                </div>
              ) : <p className="mb-4 text-sm text-muted-foreground">Sem prévia ainda: veja o que falta na lista.</p>}
              <ul className="mb-4 space-y-1.5 text-sm" aria-label="Lista de verificação do envio">
                {ev.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2">
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive-foreground" aria-label="ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-negative-foreground" aria-label="bloqueado" />}
                    <span><span className={c.ok ? "" : "font-medium"}>{c.label}</span>{c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}</span>
                  </li>
                ))}
              </ul>
              <QueueForm chargeId={chargeId} templateVersionId={templateVersionId} sessionId={sessionId} keyValue={key} canQueue={ev.canSend} />
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}
