import type { ReactNode } from "react";
import { FlaskConical, KeyRound, LogOut } from "lucide-react";
import { buttonClass } from "./button";
import { AppLink } from "./app-link";

export function DemoBanner({ emailLive = false }: { emailLive?: boolean }) {
  return (
    <div role="status" className="sticky top-0 z-50 flex h-9 items-center justify-center gap-2 bg-demo px-3 text-center text-xs font-medium text-demo-foreground">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      {emailLive
        ? <span><strong>E-MAIL REAL ATIVO (canário)</strong> — só para a lista autorizada. Boleto, nota e WhatsApp seguem simulados.</span>
        : <span><strong>VALIDAÇÃO</strong> — nenhum boleto, nota, e-mail ou WhatsApp real é emitido ou enviado.</span>}
    </div>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 font-display font-semibold">
      <span className="flex size-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">K3</span>
      {!compact && <span className="text-base">K3G Finance</span>}
    </span>
  );
}

/** Menu do usuário com <details> nativo (sem JS, acessível por teclado). `logout` é uma server action. */
export function UserMenu({ name, email, role, logout }: { name: string; email: string; role: string; logout: () => Promise<void> }) {
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <details className="relative">
      <summary aria-label={`Menu do usuário ${name}`} className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full hover:bg-accent [&::-webkit-details-marker]:hidden">
        <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-accent-foreground">{initials}</span>
      </summary>
      <div className="absolute right-0 z-50 mt-2 w-60 rounded-lg border bg-popover p-2 text-popover-foreground shadow-md">
        <div className="px-2 py-1.5"><p className="text-sm font-medium">{name}</p><p className="truncate text-xs text-muted-foreground">{email}</p><p className="mt-1 text-xs text-muted-foreground">Papel: {role}</p></div>
        <div className="mt-1 border-t pt-1"><AppLink href="/conta" className={buttonClass("ghost", "md", "w-full justify-start")}><KeyRound className="size-4" aria-hidden /> Minha conta</AppLink></div>
        <form action={logout}>
          <button className={buttonClass("ghost", "md", "w-full justify-start")}><LogOut className="size-4" aria-hidden /> Sair</button>
        </form>
      </div>
    </details>
  );
}

export function PageContainer({ children }: { children: ReactNode }) {
  return <main id="conteudo" className="mx-auto w-full max-w-7xl flex-1 px-4 pb-28 pt-6 sm:px-6 lg:pb-10">{children}</main>;
}
