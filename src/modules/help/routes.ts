// Puro (sem fs): usado também pelo cabeçalho no navegador.
/** Qual artigo explica a tela atual (o `?` do cabeçalho). Prefixo mais específico primeiro. */
const BY_ROUTE: [string, string][] = [
  ["/contratos/importar", "importar-contratos"], ["/contratos", "contratos-e-calendario"], ["/faturamento/emissoes", "emissao-simulada"], ["/faturamento", "lotes-de-cobranca"],
  ["/mensagens", "mensagens-e-regua"], ["/contas-a-receber", "contas-a-receber"], ["/contas-a-pagar", "contas-a-pagar"], ["/conciliacao", "conciliacao-bancaria"],
  ["/clientes", "clientes-e-fornecedores"], ["/integracoes", "integracoes-crm"], ["/configuracao", "usuarios-e-acessos"], ["/conta", "usuarios-e-acessos"], ["/auditoria", "registro-de-atividades"],
];
export const HELP_ROUTES = BY_ROUTE;
export function helpSlugFor(pathname: string): string | null {
  if (pathname === "/") return "dashboard";
  return BY_ROUTE.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1] ?? null;
}
