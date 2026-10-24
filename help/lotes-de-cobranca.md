# Lotes de cobrança (prévia e aprovação)

**Quem acessa:** diretoria e gerente (geram, aprovam, reabrem); assistente (gera/atualiza prévia, cancela prévia); contabilidade (somente leitura).
**Onde:** Faturamento → botão **Lotes**.

> **Simulação.** Gerar prévia e aprovar **não emite** boleto, nota fiscal, e-mail nem WhatsApp. A emissão real é uma fase futura, com credenciais e autorização própria.

## O que é um lote
Todas as cobranças previstas para **uma data de emissão** (25, 1, 8 ou 15, conforme o vencimento do contrato). Cada cobrança copia o valor, o vencimento e a competência do contrato **no momento da prévia**.

## Passo a passo
1. Em **Lotes**, escolha o mês e clique em **Gerar prévia** na data desejada.
2. Confira as cobranças, o total e os avisos. Itens **em revisão** (feriado na data de emissão, dia 31, mês curto) ficam **fora** do lote.
3. Se um contrato mudou depois da prévia, aparece o aviso amarelo: clique em **Atualizar prévia**. Gerar de novo nunca duplica cobrança.
4. **Aprovar lote** (gerente ou diretoria). Quem gerou/atualizou a prévia não a aprova — outro gerente ou a diretoria aprova. Você aprova exatamente o que está na tela.
5. Depois de aprovado, o lote não muda. Se um contrato mudar, o lote avisa; use **Reabrir para revalidar** (com motivo), atualize a prévia e aprove de novo.
6. **Cancelar lote** só vale para prévia; libera a data para uma nova prévia.

## Dúvidas comuns
- *"Nenhuma cobrança prevista para esta data"*: não há contrato ativo de cliente ativo com emissão nesse dia.
- *"Todas as cobranças desta data já estão em lotes aprovados"*: o contrato mudou de data de emissão, mas a cobrança daquela competência já foi aprovada em outro lote. Reabra o lote antigo se precisar refazer.
- *"A prévia mudou desde que você a abriu"*: outra pessoa atualizou o lote; revise de novo e aprove.

Última atualização: 2026-10-23.

## Ajustes da competência (excedente, acréscimo e desconto)
*Faturamento → Ajustes.* Para contratos com valor variável (por exemplo, o **excedente da K3G Call**, calculado em outro sistema), você **lança o valor à mão**, por contrato e por competência:
- **Excedente** e **Acréscimo** somam; **Desconto** subtrai. Cada ajuste tem uma descrição (até 120 caracteres) e no máximo 10 por contrato e competência.
- O valor da cobrança no lote fica **valor do contrato + ajustes**. A tela do lote mostra a composição ("Contrato R$ 1.000,00 + Excedente de minutos R$ 412,64").
- Depois de lançar, abra o lote e clique em **Atualizar prévia**. Lançar um ajuste com a prévia já gerada deixa o lote "desatualizado" e impede aprovar sem atualizar.
- O valor final precisa continuar **maior que zero**.
- **Quando o lote é aprovado, os ajustes ficam travados.** Para mudar, reabra o lote (com motivo); isso só é possível se ainda não houve pagamento nem emissão.
