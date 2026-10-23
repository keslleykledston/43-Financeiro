"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "./nav";

const active = (p: string, h: string) => (h === "/" ? p === "/" : p.startsWith(h));

export function SideNav() {
  const p = usePathname();
  return (
    <nav aria-label="Principal" className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-current={active(p, href) ? "page" : undefined}
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] ${active(p, href) ? "bg-blue-600 text-white" : "text-slate-700 hover:bg-slate-200/70"}`}>
          <Icon size={18} aria-hidden /> {label}
        </Link>
      ))}
    </nav>
  );
}

export function BottomNav() {
  const p = usePathname();
  return (
    <nav aria-label="Principal" className="fixed inset-x-0 bottom-0 z-20 flex border-t border-slate-200 bg-white/90 backdrop-blur md:hidden">
      {NAV.slice(0, 5).map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-current={active(p, href) ? "page" : undefined}
          className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${active(p, href) ? "text-blue-600" : "text-slate-500"}`}>
          <Icon size={20} aria-hidden /> {label}
        </Link>
      ))}
    </nav>
  );
}
