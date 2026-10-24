"use client";
import { useRef } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AppLink } from "./app-link";
import { NAV, type NavItem } from "./nav";
import { SoonTag } from "./primitives";

const isActive = (p: string, h: string, also: string[] = []) => (h === "/" ? p === "/" : [h, ...also].some((x) => p === x || p.startsWith(x + "/")));

function NavLinkItem({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <AppLink href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
      className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium", active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-accent")}>
      <Icon className="size-4" aria-hidden />
      <span className="flex-1">{item.label}</span>
      {item.soon && <SoonTag />}
    </AppLink>
  );
}

export function SideNav() {
  const p = usePathname();
  return (
    <nav aria-label="Principal" className="mt-4 flex flex-col gap-1">
      {NAV.map((n) => <NavLinkItem key={n.href} item={n} active={isActive(p, n.href, n.also)} />)}
    </nav>
  );
}

export function BottomNav() {
  const p = usePathname();
  const dlg = useRef<HTMLDialogElement>(null);
  const items = NAV.filter((n) => n.mobile).slice(0, 4);
  return (
    <>
      <nav aria-label="Principal (móvel)" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-card lg:hidden">
        {items.map((n) => {
          const Icon = n.icon; const active = isActive(p, n.href, n.also);
          return (
            <AppLink key={n.href} href={n.href} aria-current={active ? "page" : undefined}
              className={cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium", active ? "text-primary" : "text-muted-foreground")}>
              <Icon className="size-5" aria-hidden />{n.label}
            </AppLink>
          );
        })}
        <button type="button" onClick={() => dlg.current?.showModal()} className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground">
          <Menu className="size-5" aria-hidden />Mais
        </button>
      </nav>
      {/* <dialog> nativo: foco preso, Esc fecha, fundo inerte */}
      <dialog ref={dlg} aria-label="Menu completo" onClick={(e) => { if (e.target === dlg.current) dlg.current?.close(); }}
        className="m-0 mt-auto w-full max-w-none rounded-t-xl border bg-card p-4 text-card-foreground backdrop:bg-black/40">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">Menu</h2>
          <button type="button" onClick={() => dlg.current?.close()} aria-label="Fechar menu" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent"><X className="size-4" aria-hidden /></button>
        </div>
        <nav aria-label="Menu completo" className="flex flex-col gap-1 pb-4">
          {NAV.map((n) => <NavLinkItem key={n.href} item={n} active={isActive(p, n.href, n.also)} onNavigate={() => dlg.current?.close()} />)}
        </nav>
      </dialog>
    </>
  );
}
