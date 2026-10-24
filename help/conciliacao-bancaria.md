# Conciliação bancária

> O sistema só **lê** o extrato que você importa. Nada é enviado ao banco e nenhum pagamento é feito. Vincular um crédito a uma cobrança registra a baixa em **Contas a receber** e pode ser desfeito.

## Onde fica
Menu **Conciliação**. Cada empresa (CNPJ) tem suas próprias contas e extratos.

## 1. Cadastrar a conta
*Conciliação → Nova conta* (diretoria e gerente): nome, banco, **saldo inicial** e a data desse saldo. O "final da conta" (4 dígitos) é opcional e serve só para conferir se o arquivo é da conta certa. **Nunca digite o número completo.**
O saldo exibido é sempre **saldo inicial + transações importadas** ("saldo pelo extrato").

## 2. Importar o extrato (prévia → confirmar)
*Conta → Importar extrato.* Formatos:
- **OFX** (recomendado): traz identificador de cada lançamento e, em geral, o saldo do banco para conferência.
- **CSV genérico**: colunas `Data; Descrição; Valor` (ou `Crédito` e `Débito`) e, se houver, `Id`. Há um **modelo** para baixar. O layout real de cada banco (Cora, Caixa, Santander…) precisa ser validado com um arquivo de verdade antes de depender dele.

A **prévia** mostra linhas novas × já importadas, o período e **avisos** (por exemplo, o saldo do arquivo difere do calculado). Só ao **Confirmar** as transações são gravadas. Limites: 2 MB e 5.000 linhas.

Proteções:
- O mesmo arquivo não entra duas vezes. Arquivo que se sobrepõe a outro só importa o que é novo.
- **Lançamentos idênticos sem identificador** (CSV sem coluna Id): se o arquivo traz uma quantidade diferente da já importada (ex.: 3 Pix iguais quando já havia 2), a prévia marca **Ambígua** e pede que você confirme que conferiu. Prefira **OFX**, que identifica cada lançamento.
- Duas linhas realmente iguais no mesmo arquivo (dois Pix de mesmo valor e histórico) são **duas** transações.
- Arquivo de outra conta (final diferente) ou com lançamentos anteriores ao saldo inicial é recusado.
- Transação importada **não pode ser editada**. Se o arquivo era da conta errada, **Desfazer importação** (com motivo; só se nada estiver vinculado).

## 3. Conciliar
Na lista **A conciliar**, cada crédito mostra uma sugestão:
- **Sugestão forte**: o histórico traz o **documento do cliente** (inteiro, sem estar colado a outros números; aparece o final dele) e há **uma** cobrança dele com saldo igual ao valor. Aparece o botão *Conciliar com…*. Confira o histórico antes de clicar.
- **Ambígua / Cliente identificado / Mesmo valor sem identificador**: nada se aplica sozinho. Abra a transação e escolha a cobrança. **Dois Pix iguais sem identificador nunca viram "forte".**

**Juros/multa e desconto:** se o crédito é maior que a cobrança por causa de atraso, informe os **juros/multa incluídos**; se o cliente pagou menos com desconto combinado, informe o **desconto concedido**. O vínculo consome do crédito o **dinheiro** (principal + juros − desconto), e a cobrança é quitada pelo principal. Desfazer o vínculo estorna tudo.

Na transação você pode **vincular parcialmente**: um crédito pode quitar várias cobranças e uma cobrança pode receber vários créditos. O vínculo nunca passa do valor do crédito nem do saldo da cobrança. Ele cria um pagamento "Extrato bancário" em Contas a receber, com a data do crédito.

**Desfazer vínculo** (diretoria e gerente, com motivo): estorna o pagamento, devolve o saldo da cobrança e libera o crédito. O histórico fica. Pagamento vindo da conciliação só se estorna por aqui.

## Classificar (sem cobrança)
Tarifa, transferência entre contas do grupo ou outro: **Classificar** tira a transação da fila, sem criar pagamento nem receita. O pareamento entre as contas dos dois CNPJs é uma fase futura.

## Quem pode
- Ver: diretoria, gerente, assistente e contabilidade.
- Cadastrar conta e importar: diretoria e gerente.
- Vincular e classificar: diretoria, gerente e assistente.
- Desfazer vínculo/importação: diretoria e gerente.
