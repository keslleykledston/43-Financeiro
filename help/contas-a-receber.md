# Contas a receber (baixa manual)

> A baixa registrada aqui **não movimenta dinheiro** e não emite nada. É o controle do que foi cobrado e do que já entrou. A conciliação automática com o extrato do banco é uma fase futura.

## Onde fica
Menu **A receber**. Só aparecem cobranças de **lotes aprovados** (Faturamento → Lotes).

## O que a tela mostra
- **A receber**, **Vencido**, **Recebido no mês** e **Inadimplência** (vencido ÷ em aberto).
- **Envelhecimento** do vencido: 1–15, 16–30, 31–60 e mais de 60 dias.
- **Maiores devedores** (valores vencidos por cliente).
- Lista com filtro por cliente, situação, competência e período de vencimento.
- **Exportar CSV** (diretoria, gerente e contabilidade). A planilha segue o filtro da tela.

## Situação de cada cobrança
| Situação | Quando |
|---|---|
| A vencer | sem pagamento e ainda não passou do vencimento (vencer hoje ainda não é atraso) |
| Vencida | sem pagamento e passou do vencimento |
| Parcial | pagou parte; o saldo continua em aberto |
| Quitada | saldo zero |

O saldo é **sempre calculado**: valor − soma dos pagamentos ativos. Não existe botão "marcar como quitada".

## Registrar um pagamento
1. Abra a cobrança → **Registrar pagamento**.
2. Informe valor, data, forma (Pix, boleto, transferência, dinheiro, outro) e, se quiser, uma observação (sem dados pessoais).
3. **Parcial** é permitido. O **principal quitado não pode passar do saldo** e a data não pode ser futura nem anterior à emissão.
   - **Valor recebido** é o que entrou de fato (como no extrato).
   - **Juros/multa incluídos:** pagou com atraso? Informe quanto do valor recebido é juros/multa. Principal quitado = recebido − juros.
   - **Desconto/abatimento:** quitou pagando menos (desconto combinado, retenção)? Informe o desconto. Principal quitado = recebido + desconto.
   - Exemplo: cobrança de R$ 1.000,00, recebido R$ 1.030,00 com R$ 30,00 de juros → quita R$ 1.000,00. Recebido R$ 950,00 com R$ 50,00 de desconto → também quita R$ 1.000,00.
   - O painel e a lista de recebimentos somam o **dinheiro recebido** (principal + juros − desconto).
4. Se o pagamento quitar a cobrança, as **mensagens da régua** ainda não processadas são **canceladas** e a cobrança não entra mais na régua.
5. Clicar duas vezes ou recarregar a página **não** registra duas vezes.

## Estorno (corrigir engano)
Pagamento nunca é apagado. Diretoria e gerente usam **Estornar**, com motivo (5 a 300 caracteres). O pagamento fica no histórico como *Estornado* e o saldo volta. Depois é possível registrar o valor correto. Se a cobrança voltou a ter saldo e você quer retomar a régua, use **Mensagens → Programar mensagens**.

## Regras importantes
- Um lote com **pagamento ou estorno registrado não pode ser reaberto** (para não mudar o valor de algo já recebido).
- O histórico da cobrança mostra aprovação, pagamentos, estornos e mensagens simuladas, com quem fez cada ação.
- A auditoria guarda só identificadores e indicadores (sem valores, nomes ou observações).

## Quem pode
- Ver: diretoria, gerente, assistente e contabilidade.
- Registrar pagamento: diretoria, gerente e assistente.
- Estornar: diretoria e gerente.
- Exportar: diretoria, gerente e contabilidade.

> Observação: o pedido original prevê **anexos privados** (comprovante do pagamento). Ficam para a próxima entrega, por exigirem armazenamento de arquivos com revisão de segurança própria.
