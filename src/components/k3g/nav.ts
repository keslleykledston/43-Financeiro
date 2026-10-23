import { Landmark, FileText, LayoutDashboard, MessageSquare, Plug, Receipt, Settings, Users, Wallet, type LucideIcon } from "lucide-react";

export interface NavItem { label: string; href: string; icon: LucideIcon; soon?: boolean; mobile?: boolean }

/** `soon`: a tela existe com estado vazio útil, mas a entrega ainda não chegou (etiqueta "em breve"). */
export const NAV: NavItem[] = [
  { label: "Início", href: "/", icon: LayoutDashboard, mobile: true },
  { label: "Clientes", href: "/clientes", icon: Users, mobile: true },
  { label: "Contratos", href: "/contratos", icon: FileText },
  { label: "Faturamento", href: "/faturamento", icon: Receipt },
  { label: "Mensagens", href: "/mensagens", icon: MessageSquare },
  { label: "A receber", href: "/contas-a-receber", icon: Wallet },
  { label: "Conciliação", href: "/conciliacao", icon: Landmark },
  { label: "Integrações", href: "/integracoes", icon: Plug, mobile: true },
  { label: "Ajustes", href: "/configuracao", icon: Settings, mobile: true },
];
