import { CircleHelp, HandCoins, History, Landmark, FileText, LayoutDashboard, MessageSquare, Plug, Receipt, ReceiptText, Settings, Users, Wallet, type LucideIcon } from "lucide-react";

export interface NavItem { label: string; href: string; icon: LucideIcon; soon?: boolean; mobile?: boolean; /** outros caminhos que também marcam este item como ativo (ex.: /empresa dentro de Configurações) */ also?: string[] }

/** `soon`: a tela existe com estado vazio útil, mas a entrega ainda não chegou (etiqueta "em breve"). */
export const NAV: NavItem[] = [
  { label: "Início", href: "/", icon: LayoutDashboard, mobile: true },
  { label: "Clientes", href: "/clientes", icon: Users, mobile: true },
  { label: "Contratos", href: "/contratos", icon: FileText },
  { label: "Faturamento", href: "/faturamento", icon: Receipt },
  { label: "Mensagens", href: "/mensagens", icon: MessageSquare },
  { label: "A receber", href: "/contas-a-receber", icon: Wallet },
  { label: "A pagar", href: "/contas-a-pagar", icon: ReceiptText },
  { label: "Conciliação", href: "/conciliacao", icon: Landmark },
  { label: "Comissões", href: "/comissoes", icon: HandCoins },
  { label: "Histórico", href: "/historico", icon: History },
  { label: "Integrações", href: "/integracoes", icon: Plug, mobile: true },
  { label: "Ajuda", href: "/ajuda", icon: CircleHelp },
  { label: "Configurações", href: "/configuracao", icon: Settings, mobile: true, also: ["/empresa", "/auditoria"] },
];
