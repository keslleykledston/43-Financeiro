# Linha do tempo dos clientes

**Onde:** *Histórico da planilha → Linha do tempo dos clientes*.
**Quem acessa:** quem lê o histórico (diretoria, gerente e contabilidade).

> Esta tela **só lê e infere**. Não cria nem altera contrato, aditivo, cobrança, pagamento ou cliente.

## O que ela faz
Lê as abas mensais já importadas da planilha de boletos e, para cada cliente, mostra o que mudou de um mês para o outro:
- **Entrou** (primeira cobrança depois do início da planilha), **Saiu** (parou de aparecer), **Sumiu** e **Voltou** (faltou em algum mês no meio).
- **Valor subiu / baixou** (com o valor de antes e de depois) e **Vencimento mudou** (de que dia para que dia).
- **Já existia no início da planilha**: quem aparece desde a primeira aba não é "novo" (não há como saber antes).

## Ponte da receita mensal
Tabela mês a mês: **início + novos + voltaram + aumentos − reduções − saídas = fim**, pelo valor cobrado na aba de cada mês. Mostra de onde vem o crescimento ou a queda da receita recorrente. O mês mais recente é **provisório**: a aba pode estar incompleta.

## Como usar
- Filtre por **evento** (ex.: só quem saiu) ou procure um **cliente** pelo nome. **Baixar CSV** exporta todos os eventos (fica registrado no registro de atividades).
- Use como roteiro para conferir: um cliente que "saiu" talvez só tenha ficado de fora de uma aba, ou ido para o outro bloco (Solutions/Call).

## Limites
- É uma **inferência**: "estar na aba" não prova que o contrato existia ou acabou. Aditivos e datas de saída reais continuam sendo registrados nos contratos.
- Vários lançamentos do mesmo cliente na mesma aba são somados. Clientes são identificados pelo CNPJ/CPF (ou pelo nome, quando falta o documento).
- Quem some **só no último mês** aparece como "ausente (a confirmar)", nunca como saída.
