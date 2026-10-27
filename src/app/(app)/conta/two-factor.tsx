"use client";
import { useActionState } from "react";
import { beginTwoFactorAction, confirmTwoFactorAction, disableTwoFactorAction, regenerateCodesAction } from "./actions";
import { buttonClass, inputClass } from "@/components/k3g/button";
import { Callout } from "@/components/k3g/primitives";

const Err = ({ s }: { s: { error?: string } | undefined }) => (s?.error ? <p role="alert" className="text-sm text-negative-foreground">{s.error}</p> : null);

function Codes({ codes }: { codes: string[] }) {
  return (
    <Callout tone="warning" role="status">
      <p className="font-medium">Guarde estes códigos de recuperação agora. Eles não serão mostrados de novo.</p>
      <p className="text-sm">Cada código vale uma vez e serve se você perder o celular. Guarde em local seguro (gerenciador de senhas), nunca em e-mail ou chat.</p>
      <ul aria-label="Códigos de recuperação" className="mt-2 grid max-w-sm grid-cols-2 gap-1 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
    </Callout>
  );
}

export function TwoFactor({ enabled, recoveryLeft, recommended }: { enabled: boolean; recoveryLeft: number; recommended: boolean }) {
  const [begin, beginAct, beginPend] = useActionState(beginTwoFactorAction, undefined);
  const [confirm, confirmAct, confirmPend] = useActionState(confirmTwoFactorAction, undefined);
  const [off, offAct, offPend] = useActionState(disableTwoFactorAction, undefined);
  const [regen, regenAct, regenPend] = useActionState(regenerateCodesAction, undefined);
  if (confirm?.step === "codes" && confirm.codes) return <div className="space-y-3"><Callout tone="positive" role="status">Verificação em duas etapas ativada.</Callout><Codes codes={confirm.codes} /></div>;
  if (off?.step === "done") return <Callout tone="positive" role="status">Verificação em duas etapas desligada.</Callout>;
  if (enabled) {
    return (
      <div className="space-y-5">
        <Callout tone="positive">Ativa. Ao entrar, além da senha, pedimos o código do aplicativo. Códigos de recuperação restantes: <strong>{recoveryLeft}</strong>.</Callout>
        {regen?.step === "codes" && regen.codes && <Codes codes={regen.codes} />}
        <form action={regenAct} className="max-w-sm space-y-2">
          <label htmlFor="rc-code" className="block text-sm font-medium">Gerar novos códigos de recuperação</label>
          <input id="rc-code" name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="Código de 6 dígitos" required className={inputClass} />
          <Err s={regen} />
          <button disabled={regenPend} className={buttonClass("outline")}>Gerar novos códigos</button>
          <p className="text-xs text-muted-foreground">Os códigos antigos deixam de valer.</p>
        </form>
        <form action={offAct} className="max-w-sm space-y-2 border-t pt-4">
          <p className="text-sm font-medium">Desligar a verificação em duas etapas</p>
          <input name="password" type="password" autoComplete="current-password" aria-label="Senha atual para desligar" placeholder="Senha atual" required className={inputClass} />
          <input name="code" aria-label="Código para desligar" placeholder="Código do aplicativo ou de recuperação" required className={inputClass} />
          <Err s={off} />
          <button disabled={offPend} className={buttonClass("danger")}>Desligar</button>
        </form>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {recommended && <Callout tone="warning">Seu papel acessa dados financeiros sensíveis: <strong>ative a verificação em duas etapas</strong>.</Callout>}
      <p className="max-w-prose text-sm text-muted-foreground">Além da senha, o login passa a pedir um código de 6 dígitos de um aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy, 1Password…). Mesmo que alguém descubra a sua senha, não consegue entrar.</p>
      {begin?.step === "scan" ? (
        <form action={confirmAct} className="max-w-sm space-y-3">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>No aplicativo autenticador, adicione uma conta digitando esta chave (ou toque em <a className="underline" href={begin.uri}>abrir no aplicativo</a> no celular):</li>
          </ol>
          <p className="rounded-md border bg-muted px-3 py-2 font-mono text-sm tracking-wider" aria-label="Chave do aplicativo">{begin.secret}</p>
          <p className="text-sm">Tipo: baseado em tempo. Depois, digite o código que o aplicativo mostrar:</p>
          <input name="code" inputMode="numeric" autoComplete="one-time-code" aria-label="Código do aplicativo" placeholder="000000" required className={inputClass} />
          <Err s={confirm} />
          <button disabled={confirmPend} className={buttonClass("primary")}>Confirmar e ativar</button>
        </form>
      ) : (
        <form action={beginAct} className="max-w-sm space-y-2">
          <label htmlFor="tf-password" className="block text-sm font-medium">Confirme com a sua senha para começar</label>
          <input id="tf-password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
          <Err s={begin} />
          <button disabled={beginPend} className={buttonClass("primary")}>Ativar verificação em duas etapas</button>
        </form>
      )}
    </div>
  );
}
