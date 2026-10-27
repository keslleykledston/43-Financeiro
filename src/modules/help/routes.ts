// Puro (sem fs): usado também pelo cabeçalho no navegador.
/** Qual artigo explica a tela atual (o `?` do cabeçalho). Prefixo mais específico primeiro. */
const BY_ROUTE: [string, string][] = [
  ["/contratos/importar", "importar-contratos"], ["/contratos/alertas", "alertas-de-contratos"], ["/contratos", "contratos-e-calendario"], ["/faturamento/emissoes", "emissao-simulada"], ["/faturamento", "lotes-de-cobranca"],
  ["/mensagens", "mensagens-e-regua"], ["/contas-a-receber", "contas-a-receber"], ["/contas-a-pagar/relatorio", "despesas-por-categoria"], ["/contas-a-pagar", "contas-a-pagar"], ["/conciliacao", "conciliacao-bancaria"], ["/comissoes", "comissoes"], ["/historico/despesas", "historico-de-despesas"], ["/historico", "historico-da-planilha"],
  ["/clientes", "clientes-e-fornecedores"], ["/integracoes", "integracoes-crm"], ["/empresa", "dados-da-empresa"], ["/configuracao", "usuarios-e-acessos"], ["/socios/plano", "plano-de-retiradas-e-lucro"], ["/socios", "socios-e-retiradas"], ["/despesas-cadastros", "socios-e-retiradas"], ["/conta", "usuarios-e-acessos"], ["/auditoria", "registro-de-atividades"],
];
export const HELP_ROUTES = BY_ROUTE;
export function helpSlugFor(pathname: string): string | null {
  if (pathname === "/") return "dashboard";
  return BY_ROUTE.find(([p]) => pathname === p || pathname.startsWith(p + "/"))?.[1] ?? null;
}
