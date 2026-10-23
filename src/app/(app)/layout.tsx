import { requireContext } from "@/lib/security/context";
import { SideNav, BottomNav } from "@/components/nav-links";
import { switchCompany, logout } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div role="status" className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">
        DEMONSTRAÇÃO — dados fictícios. Nenhum boleto, nota ou e-mail real é emitido.
      </div>
      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-4 md:px-6">
        <aside className="sticky top-4 hidden h-[calc(100vh-4rem)] w-60 shrink-0 flex-col justify-between md:flex">
          <div>
            <p className="mb-4 px-3 text-lg font-semibold">K3G Finance</p>
            <SideNav />
          </div>
          <form action={logout}><button className="w-full rounded-xl px-3 py-2.5 text-left text-[15px] text-slate-600 hover:bg-slate-200/70">Sair</button></form>
        </aside>
        <div className="min-w-0 flex-1 pb-24 md:pb-6">
          <header className="mb-5 flex items-center justify-between gap-3">
            <form action={switchCompany} className="flex items-center gap-2">
              <label htmlFor="company" className="sr-only">Empresa</label>
              <select id="company" name="company" defaultValue={ctx.current?.id} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
                {ctx.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="rounded-xl bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-slate-300">Trocar</button>
            </form>
            <div className="flex items-center gap-3">
              <span className="hidden text-sm text-slate-600 sm:inline">{ctx.user.email}</span>
              <form action={logout} className="md:hidden"><button className="rounded-xl px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-300">Sair</button></form>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
