# Revisão Codex — E06 modelos de mensagem + fila simulada (commit 62cd5bb)
Somente leitura; testes não executados pelo Codex. **Sem P0/P1.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P2 | `processQueue` lia itens sem travar a linha; `reopenBatch` (outro lock) podia cancelar no meio e o processamento sobrescrevia `cancelado` com `simulado` | **Corrigido**: `SELECT … FOR UPDATE OF message_queue` + update condicionado a `status = 'pendente'`. Teste de corrida novo, **provado por mutação** (sem a correção ele falha). |
| 2 | P2 | `cancelBatch` apaga `charges` e a FK `ON DELETE CASCADE` apaga também o histórico simulado da fila | **Aceito na simulação** (o texto simulado não é registro de negócio; só ocorre em lote reaberto e depois cancelado; auditoria mantém ids/contagens). **Pré-requisito do E10 (envio real):** trocar a FK para `RESTRICT` e cancelar cobranças marcando `cancelada` em vez de apagar. Registrado em BACKLOG. |

Verificado pelo Codex sem problema: isolamento por `company_id` e RBAC, validação/renderização/escape de modelos, duplicatas e advisory lock, cancelamento ao reabrir, auditoria sem PII/valores, ausência de qualquer chamada externa, ordem da migração 0013 e rollback, datas.
