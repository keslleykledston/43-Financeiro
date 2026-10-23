import { notFound } from "next/navigation";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { listTemplates, previewText } from "@/modules/messaging/service";
import { CHANNELS, CHANNEL_LABEL, DEFAULTS, KINDS, KIND_LABEL, PLACEHOLDERS, PLACEHOLDER_HELP, type Channel, type Kind } from "@/modules/messaging/templates";
import { Callout, PageHeader, SectionCard, StatusPill } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { activateAction, saveDraftAction } from "../../../actions";

const STATE: Record<string, string> = { ativa: "Ativa", rascunho: "Rascunho", arquivada: "Arquivada" };

export default async function EditarModelo({ params, searchParams }: { params: Promise<{ kind: string; channel: string }>; searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const [{ kind, channel }, sp, ctx] = await Promise.all([params, searchParams, requireContext()]);
  if (!(KINDS as readonly string[]).includes(kind) || !(CHANNELS as readonly string[]).includes(channel)) notFound();
  const k = kind as Kind, ch = channel as Channel;
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "messages.read")) return <Callout tone="warning">Seu papel não tem acesso aos modelos de mensagem.</Callout>;
  const manage = can(role, "messages.templates");
  const t = (await listTemplates(db, ctx.user.id, ctx.current.id)).find((x) => x.kind === k && x.channel === ch);
  const shown = t?.draft ?? t?.active ?? null;
  const subject = shown?.subject ?? (ch === "email" ? DEFAULTS[k].subject : "");
  const body = shown?.body ?? DEFAULTS[k].body;
  const prev = previewText(subject, body);

  return (
    <div className="space-y-5">
      <PageHeader title={`${KIND_LABEL[k]} · ${CHANNEL_LABEL[ch]}`} description={`${ctx.current.name} · modelo de mensagem`}
        actions={<AppLink href="/mensagens/modelos" className={buttonClass("outline")}>Voltar</AppLink>} />
      <Callout tone="info">Simulação: este texto só é usado na fila simulada. {t?.draft ? "Você está vendo o rascunho; ele ainda não vale." : ""}</Callout>
      {sp.erro && <Callout tone="negative" role="alert">{sp.erro}</Callout>}
      {sp.ok === "rascunho" && <Callout tone="positive" role="status">Rascunho salvo. Confira a prévia e ative quando estiver certo.</Callout>}
      {sp.ok === "ativada" && <Callout tone="positive" role="status">Versão ativada.</Callout>}

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title={manage ? "Texto" : "Texto (somente leitura)"}>
          <form action={saveDraftAction} className="space-y-4">
            <input type="hidden" name="kind" value={k} /><input type="hidden" name="channel" value={ch} />
            {ch === "email" && (
              <div>
                <label htmlFor="subject" className="mb-1 block text-sm font-medium">Assunto</label>
                <input id="subject" name="subject" defaultValue={subject} maxLength={200} required disabled={!manage} className={inputClass} />
              </div>
            )}
            <div>
              <label htmlFor="body" className="mb-1 block text-sm font-medium">Mensagem</label>
              <textarea id="body" name="body" defaultValue={body} rows={12} maxLength={4000} required disabled={!manage} className={`${inputClass} h-auto py-2 font-mono`} />
              <p className="mt-1 text-xs text-muted-foreground">Texto simples. HTML não é aceito.</p>
            </div>
            {manage && <button className={buttonClass("primary")}>Salvar rascunho</button>}
          </form>
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer font-medium">Campos disponíveis</summary>
            <ul className="mt-2 space-y-1">{PLACEHOLDERS.map((p) => <li key={p}><code className="rounded bg-muted px-1">{`{{${p}}}`}</code> — {PLACEHOLDER_HELP[p]}</li>)}</ul>
          </details>
        </SectionCard>

        <SectionCard title="Prévia com dados fictícios">
          {ch === "email" && <p className="mb-2 text-sm"><span className="text-muted-foreground">Assunto:</span> <strong>{prev.subject}</strong></p>}
          <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-sans text-sm" data-testid="preview">{prev.body}</pre>
        </SectionCard>
      </div>

      <SectionCard title="Versões">
        {!t || t.versions.length === 0 ? <p className="text-sm text-muted-foreground">Ainda não há versões. Salve um rascunho ou crie os modelos padrão.</p> : (
          <ul className="divide-y divide-border">
            {t.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span>Versão {v.version} <StatusPill tone={v.state === "ativa" ? "positive" : v.state === "rascunho" ? "info" : "neutral"}>{STATE[v.state]}</StatusPill></span>
                {manage && v.state !== "ativa" && (
                  <form action={activateAction}><input type="hidden" name="kind" value={k} /><input type="hidden" name="channel" value={ch} /><input type="hidden" name="versionId" value={v.id} />
                    <button className={buttonClass("outline", "sm")}>{v.state === "rascunho" ? "Ativar" : "Restaurar esta versão"}</button></form>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
