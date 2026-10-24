import { Building2 } from "lucide-react";
import { requireContext } from "@/lib/security/context";
import { ROLE_LABEL } from "@/modules/identity/permissions";
import { db } from "@/lib/db";
import { activeRole } from "@/modules/identity/service";
import { BottomNav, SideNav } from "@/components/k3g/nav-client";
import { DemoBanner, Logo, PageContainer, UserMenu } from "@/components/k3g/shell";
import { HelpLink } from "@/components/k3g/help-link";
import { ThemeToggle } from "@/components/k3g/theme-toggle";
import { FullPageMessage } from "@/components/k3g/states";
import { buttonClass, selectClass } from "@/components/k3g/button";
import { switchCompany, logout } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  if (!ctx.current) {
    return (
      <FullPageMessage icon={Building2} title="Sem acesso" description="Sua conta não está vinculada a nenhuma empresa ativa. Peça um convite à diretoria."
        actions={<form action={logout}><button className={buttonClass("outline")}>Sair</button></form>} />
    );
  }
  const role = await activeRole(db, ctx.user.id, ctx.current.id);
  return (
    <div className="min-h-screen bg-background">
      <DemoBanner />
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-12 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">Pular para o conteúdo</a>
      <div className="flex">
        <aside className="sticky top-9 hidden h-[calc(100vh-2.25rem)] w-60 shrink-0 flex-col justify-between border-r bg-sidebar p-3 lg:flex">
          <div><div className="px-2 py-3"><Logo /></div><SideNav /></div>
          <form action={logout}><button className={buttonClass("ghost", "md", "w-full justify-start")}>Sair</button></form>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-9 z-40 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
            <span className="lg:hidden"><Logo compact /></span>
            <form action={switchCompany} className="flex flex-1 items-center gap-2">
              <label htmlFor="company" className="sr-only">Empresa</label>
              <select id="company" name="company" defaultValue={ctx.current.id} className={`${selectClass} max-w-[11rem] sm:max-w-none`}>
                {ctx.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className={buttonClass("outline", "md")}>Trocar</button>
            </form>
            <HelpLink />
            <ThemeToggle />
            <UserMenu name={ctx.user.name ?? ctx.user.email ?? "Usuário"} email={ctx.user.email ?? ""} role={role ? ROLE_LABEL[role] : "—"} logout={logout} />
          </header>
          <PageContainer>{children}</PageContainer>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
