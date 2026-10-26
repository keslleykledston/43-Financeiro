# Histórico de despesas

> Esta tela **só lê e sugere**. Nada daqui cria contas a pagar, sócios, lançamentos, fornecedores ou categorias. Só a **diretoria** vê: a aba "Casa" da planilha tem gasto pessoal dos sócios.

## O que é
A planilha de despesas do ano (uma aba por mês) é guardada **como veio**, linha por linha, em uma área de conferência que **não pode ser alterada**. A importação é feita pela operação, **com a sua autorização escrita**, e pode ser desfeita (a tela tem o botão "Desfazer importação"; nenhum cadastro é afetado).

## Onde
**Histórico de boletos → Histórico de despesas** (ou direto em `/historico/despesas`).

## O que a tela mostra
- **Totais**: despesas da empresa e da casa (pelo valor **pago**), parcelas ainda a vencer e as faturas de cartão (só referência: elas repetem linhas que já estão em Empresa e Casa, por isso não entram nos totais).
- **Por mês**: empresa × casa em cada aba. A soma é refeita pelo sistema: a planilha original deixa de somar a primeira linha em alguns meses.
- **Classificação sugerida**: cada linha ganha uma categoria e uma natureza (despesa da empresa ou retirada de sócio) por regras de palavras. É **sugestão**.
- **A classificar**: o que as regras não reconheceram, com o total pago de cada descrição.
- **Candidatas a conta recorrente**: descrições que se repetem em 3 meses ou mais com valor parecido (Vivo, energia, Simples…), com valor e dia típicos.
- **Parcelamentos encontrados**: "14/36" e "13º" (quando o total não está escrito, aparece "total desconhecido"), com a última parcela vista, quantas restam e quanto.
- **Para revisar** (com aba e linha no CSV de divergências): linhas sem valor, data escrita como texto ("19/02"), vencimento fora do mês da aba, pago a menos ou diferente, classificação que pede confirmação, linhas que parecem ser da **K3G Call** e as do **K3G 2** (imóvel de expansão).

Regra do dono: a despesa **só conta como paga quando tem data de pagamento**. Linha com valor e **sem data de pagamento** fica como **pendente de pagamento (em aberto)** quando o histórico for aplicado (aparece aqui como informativo). Linhas **sem valor** ficam de fora, e o pago a menos que a conta continua em revisão (pode ser pagamento parcial).

## Downloads
- **Classificação sugerida (CSV)**: todas as linhas com a categoria, a natureza, a empresa e o centro sugeridos.
- **Divergências (CSV)**: o que revisar, com aba e linha.

## O que vem depois
Depois que você conferir a classificação, a **aplicação** (criar contas a pagar já pagas, lançamentos dos sócios, recorrentes e parcelamentos) é uma etapa **separada**, que exige uma nova autorização sua. Cruzar com os **extratos bancários** deixa a aplicação mais segura.
