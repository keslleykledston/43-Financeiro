# Revisão Codex — D2 recorrentes, parcelas e calendário (2026-10-25, somente leitura)

Escopo: modelos mensais, séries de parcelas, calendário, geração de rascunhos, migração 0033, telas.

**Resultado: 0 P0, 0 P1, 2 P2 — ambos corrigidos.**

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | Parcela parcialmente paga entrava no restante pelo valor cheio | Corrigido: o restante usa o valor REAL da conta (o rascunho pode ter sido ajustado) menos as baixas ativas; parcelas não geradas usam o valor da série; teste com baixa parcial |
| 2 | P2 | "Recorrentes por mês" somava modelos que ainda não começaram | Corrigido: só entram modelos com início ≤ mês atual e sem fim anterior; teste |

Sem achado: isolamento por empresa (FKs compostas e filtros), idempotência/lock/índices parciais (inclusive conta cancelada ocupando a chave), datas em UTC (dia 31, bissexto, virada de ano), `payables_guard` sem regressão frente à 0018/0032, `payables_origin_chk`, rollback na ordem certa, sem SQL sem parâmetro nem XSS.
