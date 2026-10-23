import { LayoutDashboard, Users, FileText, Receipt, Wallet, Landmark, Settings } from "lucide-react";

export const NAV = [
  { href: "/", label: "Início", icon: LayoutDashboard },
  { href: "/clientes", label: "Clientes", icon: Users },
  { href: "/contratos", label: "Contratos", icon: FileText },
  { href: "/faturamento", label: "Faturamento", icon: Receipt },
  { href: "/contas-a-receber", label: "A receber", icon: Wallet },
  { href: "/conciliacao", label: "Conciliação", icon: Landmark },
  { href: "/configuracao", label: "Ajustes", icon: Settings },
] as const;
