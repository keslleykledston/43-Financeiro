# Sócios e retiradas

> **O sistema não paga nada.** Aqui você **registra** o que a empresa pagou de gasto pessoal dos sócios e o que os sócios pagaram pela empresa. Só a diretoria lança e vê.

## Para que serve
Misturar despesa pessoal com a da empresa esconde o lucro verdadeiro e dificulta a distribuição de lucros. Cada gasto pessoal pago pela empresa vira uma **retirada** na conta-corrente do sócio, que depois é **compensada na distribuição de lucros**.

## Onde
- Menu **Sócios**: saldo de cada sócio, lançamentos e CSV.
- **Configurações → Despesas**: cadastro dos sócios, centros de custo e categorias.

## Tipos de lançamento (e o efeito no saldo)
| Tipo | Quando usar | Saldo |
|---|---|---|
| **Retirada** | A empresa pagou algo pessoal (ex.: fatura de cartão pessoal) | o sócio passa a dever |
| **Despesa da empresa paga pelo sócio** | Compra da empresa feita no cartão/conta pessoal | a empresa passa a dever ao sócio |
| **Devolução do sócio** | O sócio repôs o dinheiro | reduz o que ele deve |
| **Reembolso ao sócio** | A empresa devolveu ao sócio | reduz o que deve a ele |
| **Compensação na distribuição de lucros** | A distribuição de lucros quitou retiradas | reduz o que ele deve |

**Saldo** negativo = o sócio deve à empresa (a compensar nos lucros). Positivo = a empresa deve ao sócio.

## Como lançar
1. **Sócios → Novo lançamento**: sócio, tipo, categoria, data (não pode ser futura), valor e descrição.
2. Sem categoria, o lançamento fica em **A classificar** e aparece em destaque no cartão do sócio. Classifique quando tiver o detalhe (ex.: a fatura detalhada do cartão).
3. **Fatura de cartão pessoal paga pela empresa** sem o detalhe das compras: lance como retirada em "A classificar". Quando tiver o detalhe, estorne e lance de novo por categoria (e, se houver compra da empresa na fatura, como "despesa da empresa paga pelo sócio").

## Corrigir
Nada se apaga. **Estornar** (com motivo) tira o lançamento do saldo e mantém o histórico; depois lance o correto. Reenviar o mesmo formulário não duplica.

## Cadastros (Configurações → Despesas)
- **Sócios**: nome e ativo/inativo (quem tem lançamentos não é apagado, só desativado).
- **Centros de custo**: separam áreas ou projetos (ex.: "K3G 2 — imóvel de expansão") para não distorcer o resultado da operação. Aparecem em Contas a pagar.
- **Categorias**: já vêm ~30 prontas (folha, impostos, operação, financeiro… e as de gasto pessoal). Você renomeia, desativa ou cria novas. "A classificar" não pode ser desativada.

## Contas a pagar
Cada conta pode ter **categoria**, **centro de custo** e **mês de competência** (o mês a que a despesa pertence, que pode ser diferente do vencimento). Depois de enviada para aprovação, a classificação não muda (como o resto da conta).

## Quem pode
Ver e lançar: **diretoria**. Categorias e centros: diretoria (`payables.manage`). Os demais papéis não veem esta tela.

> Importar a planilha de despesas, recorrências, parcelas e o plano de retiradas com previsão de lucro são as próximas fases.
