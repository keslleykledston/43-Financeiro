import { CheckCircle2, XCircle } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { can } from "@/modules/identity/permissions";
import { evaluateTestSend, getAuthorization, listSendLog, listSessions, recentBlocks } from "@/modules/whatsapp/service";
import { Callout, PageHeader, SectionCard, StatusPill, type StatusTone } from "@/components/k3g/primitives";
import { AppLink } from "@/components/k3g/app-link";
import { buttonClass, inputClass, selectClass } from "@/components/k3g/button";
import { AuthorizationForm, SendForm } from "./forms";
import { revokeAuthorizationAction, settleStaleAction } from "../actions";

const TONE: Record<string, StatusTone> = { enviado: "positive", falhou: "negative", desconhecido: "warning", enviando: "info" };

export default async function TesteWhatsApp({ searchParams }: { searchParams: Promise<{ sessionId?: string; phone?: string; ok?: string }> }) {
  const [sp, ctx] = await Promise.all([searchParams, requireContext()]);
  const role = ctx.current ? await activeRole(db, ctx.user.id, ctx.current.id) : null;
  if (!ctx.current || !role || !can(role, "whatsapp.read")) return <Callout tone="warning">Seu papel não tem acesso ao WhatsApp.</Callout>;
  const [auth, sessions, log, blocks] = await Promise.all([getAuthorization(db, ctx.user.id, ctx.current.id), listSessions(db, ctx.user.id, ctx.current.id), listSendLog(db, ctx.user.id, ctx.current.id, 10), recentBlocks(db, ctx.user.id, ctx.current.id, 8)]);
  const send = can(role, "whatsapp.send"), authorize = can(role, "whatsapp.authorize");
  const sessionId = String(sp.sessionId ?? "").slice(0, 40), phone = String(sp.phone ?? "").slice(0, 40);
  const ev = send && sessionId ? await evaluateTestSend(db, ctx.user.id, ctx.current.id, { sessionId, phone }) : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Enviar teste de WhatsApp" description={`${ctx.current.name} · um número autorizado de cada vez.`} actions={<AppLink href="/whatsapp" className={buttonClass("outline")}>Conexões</AppLink>} />
      {sp.ok === "autorizacao" && <Callout tone="positive" role="status">Autorização registrada. Nada foi enviado: o teste só sai com a chave do servidor ligada e a sua confirmação aqui embaixo.</Callout>}
      {sp.ok === "reservas" && <Callout tone="positive" role="status">Reservas presas encerradas como «sem confirmação». Nada foi reenviado.</Callout>}
      <Callout tone="info">Este é um <strong>envio manual de teste</strong>, com texto fixo, só para números autorizados. Não existe cobrança, régua nem resposta automática nesta etapa.</Callout>

      <SectionCard title="1. Autorização de envio" action={auth ? <StatusPill tone="positive">Ativa</StatusPill> : <StatusPill tone="warning">Não registrada</StatusPill>}>
        {auth ? (
          <div className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Referência:</span> {auth.reference}</p>
            <p><span className="text-muted-foreground">Números ({auth.count}):</span> {auth.phones.join(", ")}</p>
            <p><span className="text-muted-foreground">Limite diário:</span> {auth.dailyLimit}</p>
            {authorize && <form action={revokeAuthorizationAction}><button className={buttonClass("danger", "sm")}>Revogar autorização</button></form>}
          </div>
        ) : authorize ? <AuthorizationForm /> : <p className="text-sm text-muted-foreground">Peça à diretoria para registrar a autorização.</p>}
        {auth && authorize && <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted-foreground">Registrar nova autorização (substitui a atual)</summary><div className="mt-3"><AuthorizationForm /></div></details>}
      </SectionCard>

      {send && (
        <SectionCard title="2. Conferir e enviar">
          <form method="get" className="mb-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div><label htmlFor="c-session" className="mb-1 block text-sm font-medium">Conexão</label>
              <select id="c-session" name="sessionId" defaultValue={sessionId} className={`${selectClass} w-full`}><option value="">Escolha…</option>{sessions.map((s) => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select></div>
            <div><label htmlFor="c-phone" className="mb-1 block text-sm font-medium">Número de destino</label><input id="c-phone" name="phone" defaultValue={phone} inputMode="tel" placeholder="92 99999-0000" className={inputClass} /></div>
            <button className={buttonClass("outline")}>Conferir</button>
          </form>
          {ev && (
            <ul className="mb-4 space-y-1.5 text-sm" aria-label="Lista de verificação do envio">
              {ev.checks.map((c) => (
                <li key={c.key} className="flex items-start gap-2">
                  {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive-foreground" aria-label="ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-negative-foreground" aria-label="bloqueado" />}
                  <span><span className={c.ok ? "" : "font-medium"}>{c.label}</span>{c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}</span>
                </li>
              ))}
            </ul>
          )}
          <SendForm sessions={sessions.map((s) => ({ id: s.id, name: s.displayName }))} sessionId={sessionId} phone={phone} canSend={!!ev?.canSend} />
        </SectionCard>
      )}

      <SectionCard title="Envios bloqueados (motivo)">
        {blocks.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum envio bloqueado ainda.</p> : (
          <ul className="space-y-2 text-sm" aria-label="Envios bloqueados">{blocks.map((b, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-3"><span className="text-muted-foreground">{b.at.toLocaleString("pt-BR", { timeZone: "America/Manaus" })}</span><span>{b.reasons.length ? b.reasons.join(" · ") : "—"}</span></li>
          ))}</ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Cada tentativa bloqueada fica registrada com o motivo (sem número e sem texto). Nada foi enviado nestes casos.</p>
      </SectionCard>

      <SectionCard title="Últimos envios de teste">
        {log.length === 0 ? <p className="text-sm text-muted-foreground">Nenhum envio ainda.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="pb-2 pr-4 font-medium">Quando</th><th className="pb-2 pr-4 font-medium">Número</th><th className="pb-2 pr-4 font-medium">Situação</th><th className="pb-2 font-medium">Motivo</th></tr></thead>
            <tbody>{log.map((l) => (
              <tr key={l.id} className="border-t"><td className="py-2 pr-4">{l.at.toLocaleString("pt-BR", { timeZone: "America/Manaus" })}</td><td className="py-2 pr-4">{l.phone}</td>
                <td className="py-2 pr-4"><StatusPill tone={TONE[l.status] ?? "neutral"}>{l.status === "desconhecido" ? "sem confirmação" : l.status}</StatusPill></td><td className="py-2 text-muted-foreground">{l.error ?? "—"}</td></tr>
            ))}</tbody></table></div>
        )}
        {authorize && log.some((l) => l.status === "enviando" && Date.now() - l.at.getTime() > 10 * 60_000) && (
          <form action={settleStaleAction} className="mt-3"><Callout tone="warning">Há envio travado em «enviando» há mais de 10 minutos (o servidor caiu no meio). Ele ocupa o limite do dia. <button className={buttonClass("outline", "sm", "ml-2")}>Encerrar como sem confirmação</button></Callout></form>
        )}
        <p className="mt-3 text-xs text-muted-foreground">«Sem confirmação» significa que a WAHA não respondeu: a mensagem pode ter chegado e <strong>não é reenviada sozinha</strong>.</p>
      </SectionCard>
    </div>
  );
}
