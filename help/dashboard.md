# Painel executivo (Início) — como interpretar

O painel mostra **números reais** calculados no momento em que a página abre. O topo da tela lembra que o ambiente é de **validação**: nenhum boleto, nota, e-mail ou WhatsApp real é emitido ou enviado.

## Escolher a visão
- **Empresa** (padrão): a empresa selecionada no topo.
- **Grupo**: aparece se você tem acesso a mais de uma empresa. Soma **empresa por empresa**, só nas que você pode ver. Empresas sem acesso financeiro ficam de fora e são avisadas na tela.

## Indicadores (clique para ver a origem)
| Indicador | O que é | Origem |
|---|---|---|
| **A receber** | saldo das cobranças aprovadas ainda não pagas | A receber |
| **Vencido** | parte do "a receber" com vencimento antes de hoje (e % do valor em aberto) | A receber → Vencidas |
| **Emitido no mês** | cobranças de lotes **aprovados**, pela data de **emissão** | Faturamento → Lotes |
| **Recebido no mês** | pagamentos **ativos**, pela data do pagamento (estorno não conta) | A receber → Recebimentos do mês |
| **Saldo pelo extrato** | saldo inicial + movimentos importados; "Banco não conectado" se não há conta | Conciliação |
| **Créditos a conciliar** | entradas do extrato ainda sem cobrança vinculada | Conciliação |

"A receber" **não** é saldo de banco. Emitido e recebido caem em meses diferentes de propósito: o serviço de um mês é cobrado com vencimento no mês seguinte.

## Gráficos
- **Emitido × recebido (6 meses).** Passe o mouse (ou use a tabela escondida para leitor de tela) para ver os valores exatos.
- **Entradas projetadas — 13 semanas**, semana de segunda a domingo:
  - **Confirmado**: cobranças aprovadas com vencimento naquela semana (pelo saldo, descontados pagamentos parciais). Qualidade **alta**.
  - **Previsto pelos contratos**: cobranças que os contratos ativos indicam, mas que **ainda não foram emitidas**. Qualidade **média**. Quando o lote é aprovado, o valor passa de "previsto" para "confirmado" (nunca conta em dobro).
  - O que **já venceu** não entra como entrada projetada: o sistema não inventa quando será pago. Aparece à parte, em vermelho.
  - **Só entradas.** Contas a pagar ainda não existem, então as saídas não estão consideradas.

## "O que precisa de atenção"
Regras simples, sem IA, cada uma com botão para onde se resolve: cobranças vencidas (crítico se ≥ 10% do valor em aberto ou há mais de 30 dias de atraso), lote em prévia perto ou depois da data de emissão, cobranças previstas por contrato sem emissão, vencimentos em até 3 dias, créditos a conciliar, extrato desatualizado (> 7 dias), mensagens bloqueadas, emissões com falha, clientes ativos sem contrato e sem contato financeiro com e-mail.

## Grupo e transferências entre contas
Transferências entre as contas das duas empresas, classificadas em **Conciliação**, **não** são receita nem recebimento. No consolidado elas aparecem separadas (entradas e saídas) e se anulam no saldo.

## Dados ausentes
A última seção da tela lista o que falta para o painel ser completo (por exemplo, nenhuma conta bancária cadastrada). Sempre confira o período, a data de hoje e o aviso de validação antes de decidir com base nos números.
