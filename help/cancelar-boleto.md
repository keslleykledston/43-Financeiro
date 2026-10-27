# Cancelar boleto

**Quem pode:** somente a **diretoria**. **Onde:** *A receber* → abrir a cobrança → bloco **Boleto** → *Cancelar boleto (só a diretoria)*.

## Quando cancelar
Boleto emitido com valor, vencimento ou cliente errado, ou que não deve mais ser cobrado. Cancelar **não mexe em dinheiro**: só pede ao banco (Cora) para invalidar o boleto.

## O que é exigido
- O boleto precisa estar **emitido** e a cobrança **sem nenhum pagamento registrado**. Se houver, estorne o pagamento primeiro.
- **Motivo** obrigatório (3 a 200 caracteres) e a caixa **Confirmo o cancelamento** marcada.
- Não se cancela duas vezes o mesmo boleto.

## O que acontece
1. O pedido é registrado **antes** de falar com o banco (quem, quando, motivo e qual boleto).
2. O sistema pede o cancelamento ao provedor. Hoje o provedor é **simulado**: nada é cancelado de verdade no banco enquanto a emissão real estiver desligada.
3. Se deu certo, o boleto aparece como **Cancelado**, a régua de mensagens daquela cobrança é interrompida e a cobrança fica livre para uma **nova emissão** (em *Faturamento → Emissões*), que gera um boleto novo.

## Se algo der errado
- **O banco diz que o boleto já foi pago:** não cancela. A falha fica registrada e a emissão passa a mostrar "pago no provedor"; registre o recebimento.
- **Sem resposta do banco:** o registro fica como *Sem resposta conclusiva*. Use **Reconsultar**: o sistema confere a situação do boleto antes de pedir de novo, para nunca cancelar duas vezes ou perder o resultado. Depois de 5 tentativas sem resposta, passa para *Não cancelado* e é preciso conferir no banco.

## Registro
Cada cancelamento fica no histórico do bloco **Boleto** e no *Registro de atividades* (sem dados do cliente). O registro **não pode ser apagado nem alterado**: o próprio banco de dados recusa.

## Pedir o cancelamento (gerente e assistente)
Quem não é da diretoria pode **pedir** o cancelamento: na cobrança, bloco *Boleto*, **Pedir o cancelamento deste boleto (a diretoria decide)**, com o motivo. Nada muda no boleto até a diretoria decidir.
- **Diretoria:** o pedido aparece na própria cobrança (e como aviso na Visão executiva). **Aprovar e cancelar o boleto** executa o cancelamento normal, com o nome de quem aprovou; **Recusar** exige uma resposta e o boleto continua valendo.
- **Quem pediu** pode **retirar** o pedido enquanto ele estiver aguardando.
- Se, entre o pedido e a aprovação, entrar um pagamento (ou o boleto já tiver sido cancelado), a aprovação não segue e o pedido volta para a fila.
- Se o sistema for interrompido no meio da aprovação (raro), o pedido fica "aprovado" sem o boleto cancelado; depois de 10 minutos a diretoria aprova de novo para concluir. Se a diretoria cancelar direto ou entrar um pagamento, o pedido pode ser encerrado recusando-o.
- Só pode haver um pedido aguardando por cobrança. Tudo fica no registro de atividades (apenas os identificadores, sem o motivo).
