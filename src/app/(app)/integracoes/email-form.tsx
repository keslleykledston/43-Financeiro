"use client";
import { useActionState } from "react";
import { saveEmailAction } from "./actions";

const box = "w-full rounded-md border border-input bg-card px-3 py-2.5 text-sm";
type Cur = { host: string; port: number; security: string; fromEmail: string; fromName: string; replyTo: string } | null;
const L = ({ id, children }: { id: string; children: React.ReactNode }) => <label htmlFor={id} className="mb-1 block text-sm font-medium">{children}</label>;

/** Usuário e senha: escrita apenas (nunca voltam para a tela). Em branco, com conta já guardada, mantêm os atuais. */
export function EmailForm({ current }: { current: Cur }) {
  const [s, act, pending] = useActionState(saveEmailAction, undefined);
  const v = s?.values;
  const cur: Cur = v ? { host: v.host, port: Number(v.port), security: v.security, fromEmail: v.fromEmail, fromName: v.fromName, replyTo: v.replyTo } : current;
  return (
    <form action={act} autoComplete="off" className="space-y-3" key={s?.saved ?? s?.error ?? "n"}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2"><L id="email-host">Servidor SMTP</L><input id="email-host" name="host" required maxLength={253} defaultValue={cur?.host ?? ""} placeholder="smtp.k3gsolutions.com.br" className={box} /></div>
        <div><L id="email-port">Porta</L><select id="email-port" name="port" defaultValue={String(cur?.port ?? 587)} className={box}><option value="587">587</option><option value="465">465</option><option value="2525">2525</option><option value="25">25</option></select></div>
      </div>
      <div><L id="email-security">Segurança da conexão</L><select id="email-security" name="security" defaultValue={cur?.security ?? "starttls"} className={box}><option value="starttls">STARTTLS (portas 587, 2525 ou 25)</option><option value="ssl">SSL/TLS direto (porta 465)</option></select></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><L id="email-from">E-mail remetente</L><input id="email-from" name="fromEmail" type="email" required maxLength={200} defaultValue={cur?.fromEmail ?? ""} placeholder="financeiro@k3gsolutions.com.br" className={box} /></div>
        <div><L id="email-fromName">Nome do remetente (opcional)</L><input id="email-fromName" name="fromName" maxLength={80} defaultValue={cur?.fromName ?? ""} placeholder="K3G Solutions — Financeiro" className={box} /></div>
      </div>
      <div><L id="email-replyTo">Responder para (opcional)</L><input id="email-replyTo" name="replyTo" type="email" maxLength={200} defaultValue={cur?.replyTo ?? ""} className={box} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><L id="email-user">Usuário SMTP{current ? " (em branco = manter)" : ""}</L><input id="email-user" name="user" type="password" autoComplete="off" maxLength={200} required={!current} className={box} /></div>
        <div><L id="email-password">Senha SMTP{current ? " (em branco = manter)" : ""}</L><input id="email-password" name="password" type="password" autoComplete="new-password" maxLength={500} required={!current} className={box} /></div>
      </div>
      <p className="text-xs text-muted-foreground">Usuário e senha são guardados <strong>cifrados</strong> e <strong>nunca</strong> aparecem de volta nesta tela. Use uma senha de aplicativo/SMTP dedicada ao sistema, não a senha pessoal da caixa.</p>
      {s?.error && <p role="alert" className="text-sm text-negative-foreground">{s.error}</p>}
      {s?.saved && <p role="status" className="text-sm text-positive-foreground">{s.saved}</p>}
      <button disabled={pending} className="rounded-md bg-card px-4 py-2.5 text-sm ring-1 ring-input disabled:opacity-60">Guardar conta de e-mail</button>
    </form>
  );
}
