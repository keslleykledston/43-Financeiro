# Revisão Codex (somente leitura) — E30: pedido de cancelamento de boleto

Resultado: 0 P0, 0 P1, 2 P2 (ambos corrigidos).
- **P2 — aprovado sem cancelamento (processo caiu no meio)**: sem fluxo para retomar. Corrigido: após 10 min a diretoria aprova de novo e conclui (`stuck`); tela e ajuda explicam.
- **P2 — pedido pendente que ninguém resolve** (diretoria cancelou direto ou entrou pagamento): os controles sumiam. Corrigido: a diretoria sempre pode recusar enquanto pendente; aprovar só aparece se o boleto ainda pode ser cancelado.
Sem achado: escalonamento de permissão, corridas (aprovações simultâneas, aprovar × retirar/recusar), reversão que apague decisão alheia, isolamento por empresa, `decided_chk` e FKs compostas da migração.
