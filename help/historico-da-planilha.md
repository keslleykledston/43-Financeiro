# Histórico da planilha de boletos

**Quem acessa:** diretoria, gerente e contabilidade **leem**. Só a diretoria **importa** ou desfaz a importação (a importação é feita pela operação, com a autorização da diretoria).
**Onde:** menu **Histórico**.

> Esta tela **só lê e mede**. Nada aqui cria ou altera clientes, contratos, cobranças, pagamentos, mensagens ou emissões. É o primeiro passo (H1) para aproveitar as abas mensais da planilha como histórico de clientes e de caixa.

## O que é guardado
Cada linha de cobrança da planilha (cliente, CNPJ/CPF, valores, vencimento, data de pagamento, observação) é guardada **como veio**, por empresa, com a aba e a linha de origem. Fica **imutável**: para corrigir, desfaz-se a importação e importa-se de novo. O e-mail e o contato da planilha **não** são guardados.
- Importar o **mesmo arquivo** duas vezes não duplica (o arquivo é identificado por uma impressão digital). Se vier um arquivo novo, ele passa a ser o usado nos relatórios; os anteriores ficam guardados.

## O que a tela mostra
- **Por aba (mês do vencimento):** linhas, total cobrado, total recebido (líquido) e o que está em aberto (vencido sem data de pagamento). A aba é o mês do **vencimento**; a competência do serviço é o mês anterior.
- **Caixa por mês de pagamento:** quanto entrou em cada mês, pelas datas de pagamento da planilha. Vale como estimativa até conferir com o extrato do banco.
- **Divergências**, em lista e em **CSV**:
  - para **revisar**: vencimento fora do mês da aba (regra: o mês da aba manda) ou ausente; pago mais de 120 dias depois do vencimento; pagamento com data futura; cliente sem CNPJ/CPF, ou inválido, ou que não está no cadastro da empresa; possível duplicidade (mesmo cliente, mesmo valor e mesmo vencimento na mesma aba);
  - **informativas**: cliente com mais de uma cobrança na mesma aba (valores ou vencimentos diferentes, normal quando há mais de um serviço), líquido diferente do valor (juros, multa ou desconto) e pago sem valor líquido (aparece como estimativa, fora do total recebido).

## O que isto NÃO faz (ainda)
Não gera cobranças nem baixas históricas, não muda o início da vigência dos contratos e não cria a linha do tempo dos clientes. Esses passos (H2 e H3) dependem de revisar as divergências e de **nova autorização escrita** da diretoria para a carga histórica.

## Desfazer
Diretoria: **Desfazer importação** (com confirmação) apaga só as linhas guardadas para análise; nenhum cadastro é afetado. Fica registrado no *Registro de atividades*.
