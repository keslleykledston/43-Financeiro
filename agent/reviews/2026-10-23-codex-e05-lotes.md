# Revisão Codex — E05 lotes de cobrança, 2026-10-23
Escopo: commit 67d08e8 (prévia idempotente, aprovação, reabrir/cancelar, migração 0012). Somente leitura; sem P0.

| # | Prio | Achado | Status |
|---|------|--------|--------|
| 1 | **P1** | TOCTOU: entre recalcular a atualidade e o commit da aprovação, alteração concorrente de contrato/cliente/feriado aprovaria prévia desatualizada (o advisory lock só serializava operações de lote) | CORRIGIDO: durante a aprovação, `FOR SHARE` em contratos e clientes da empresa + `LOCK TABLE holidays IN SHARE MODE`; escritas concorrentes esperam o commit. Teste com transação concorrente aberta (contrato e feriado): aprovação espera e depois recusa. **Provado por mutação**: sem o lock o teste falha. |
| 2 | P2 | Hash/atualidade não incluíam `warnings` (feriado no vencimento mudava o aviso sem invalidar o hash) | CORRIGIDO: `warnings` entram na assinatura; teste (feriado no vencimento → stale + hash muda + aprovação com hash antigo recusada). |
Sem achados: isolamento por empresa (queries, FKs compostas), autorização (admin_tecnico sem leitura, contabilidade só lê), segregação gerador≠aprovador, idempotência (índices parciais), dinheiro, migração 0012 e rollback documentado, querystring/redirect, itens de revisão fora do lote, nenhuma operação externa, comentário `//` engolindo cadeia Drizzle.
Limites do Codex: não executou testes; não declarou explicitamente (a) auditoria sem nomes/valores/motivo livre nem (b) FOR UPDATE. Verificação própria: auditoria grava só ids/datas/contagens (teste assertando ausência de nomes/valores); FOR UPDATE presente em generate/approve/reopen/cancel; `reopen_reason` (texto livre) fica na tabela do lote, não na auditoria.
Evidência: SANDBOX PASS — 129 unit/integração + 49 e2e.
