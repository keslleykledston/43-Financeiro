# Revisão Codex — E05c ajustes da competência + E07c juros/multa/desconto (commit e0d6cc5)
Somente leitura; testes não executados pelo Codex. **Sem P0 e sem P1.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P2 | Remover um ajuste apagava a linha e a auditoria (só ids) não permitia reconstruir valor/motivo | **Corrigido sem quebrar a regra "auditoria sem valores/nomes"**: remover passa a ser **marcar como removido** (`removed_by/removed_at`); a linha fica no histórico, fora do cálculo; DELETE e edição proibidos por trigger. Testes. |
| 2 | P2 | O hash do lote cobria o total dos ajustes, mas não os itens: trocar itens por outros de mesmo total passava na aprovação | **Corrigido**: `charges.adjustment_detail` (snapshot dos itens: tipo, descrição, valor) entra na assinatura do lote; a tela mostra o snapshot salvo; trocar itens deixa o lote desatualizado e a aprovação é recusada até atualizar. Teste. |
| 3 | P2 | Ajuste que estourasse o teto de R$ 99.999.999.999,99 só falhava depois, ao atualizar o lote | **Corrigido**: validado ao lançar. Teste. |

Migração 0019 regenerada (ainda não implantada) com as colunas novas.

Verificado sem problema pelo Codex: lock `billing-batch:` compartilhado entre ajuste/geração/aprovação, trava depois de aprovado (serviço e trigger), reabrir/cancelar, composição `amount = base + ajuste` (CHECK + backfill), valor ≤ 0 impossível, isolamento e RBAC, segregação (assistente lança, outro usuário aprova), principal = recebido − juros + desconto, teto no principal, dinheiro sempre > 0, estorno, vínculo bancário pelo dinheiro (serviço e trigger), recebido nos painéis só com dinheiro e sem estornados, guards recriados sem regressão (`k3g.bank_undo`, imutabilidade, `payment_still_active`), regressões em E05/E07/E08/E10/E12, UI sem XSS.
