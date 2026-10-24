# Comissões de parceiros

**Quem acessa:** diretoria e gerente veem e operam (marcar contratos, fechar o mês, registrar o pagamento). Contabilidade só consulta. Assistente e admin técnico não veem.
**Onde:** menu **Comissões**. A marca e o percentual ficam no próprio contrato (bloco *Comissão de parceiro*).

## A regra
- Cada contrato pode ter um **parceiro** (ex.: Medina) e um **percentual próprio**.
- A comissão é o percentual **sobre o valor mensal do contrato** (sem excedente nem ajustes da competência).
- Conta o que foi **recebido**: a cobrança entra no mês em que ficou **totalmente paga** (data da última baixa). Cobrança parcial, em aberto ou vencida não gera comissão; se o cliente paga em duas vezes, vale a data da segunda.
- **No dia 16** paga-se a comissão do que foi recebido **no mês anterior**. Ex.: no dia 16/10 paga-se o que os clientes pagaram em setembro.
- O sistema **não paga**: calcula, congela e guarda o registro de quando você pagou.

## Passo a passo
1. **Marcar o contrato.** Abra o contrato → *Comissão de parceiro* → informe o parceiro e o percentual (ex.: `30` ou `12,5`) → *Salvar comissão*. Para tirar a comissão, apague o nome do parceiro. Contratos que vieram da planilha com a marca *medina* ficam **sem percentual** até você preencher.
2. **Ver o mês.** Em *Comissões*, escolha o parceiro e o mês de **recebimento**. Cada linha mostra o cliente, quando foi pago, o valor mensal, o percentual e a comissão. Até fechar, o total é só uma **prévia**.
3. **Fechar o mês.** A partir do dia 1 do mês seguinte, *Fechar o mês* congela as linhas. Não fecha enquanto algum contrato recebido estiver sem percentual: o aviso diz quais.
4. **Pagar.** Pague no banco e volte para *Marcar como pago* com a data. Se o percentual estava errado antes de pagar, *Cancelar fechamento* (com motivo) e feche de novo.
5. **Baixar CSV** para conferir ou enviar ao parceiro.

## O que muda e o que não muda
- Mudar o percentual de um contrato vale só para os **próximos** fechamentos. Fechamentos feitos continuam como foram.
- Para **mudar ou tirar** o parceiro/percentual de um contrato que já tem cobrança recebida fora de fechamento, primeiro feche o mês (o sistema bloqueia para não reescrever o que já se qualificou). Preencher o percentual que faltava não é bloqueado.
- Um fechamento **pago** não pode ser cancelado nem alterado.
- Baixa **estornada depois do fechamento**: o fechamento não muda sozinho, mas a linha ganha o aviso *baixa estornada*. Se ainda não pagou, cancele e feche de novo; se **já pagou**, acerte a diferença com o parceiro no próximo pagamento (ainda não há lançamento de acerto no sistema).
- Baixa lançada **depois** do fechamento com data dentro do mês: aparece como *ainda não entrou no fechamento*. Cancele o fechamento (se não foi pago) e feche de novo.
- Cada cobrança entra em um único fechamento válido.

## Limites
- Comissão de **cobrança parcial** (proporcional ao recebido) ainda não existe: só entra a quitada.
- O pagamento da comissão não gera lançamento em *Contas a pagar*; fica registrado aqui.
