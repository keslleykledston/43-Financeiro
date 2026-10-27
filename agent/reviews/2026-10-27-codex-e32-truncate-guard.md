# Revisão Codex (somente leitura) — E32: bloqueio de TRUNCATE

Resultado: 0 P0, 2 P1, 2 P2.
- **P1 — `audit_log` fora da lista**: corrigido (23 tabelas).
- **P1 — GUC `k3g.allow_truncate` não é barreira contra SQL arbitrário**: a GUC foi REMOVIDA (só aumentava a superfície; com SQL arbitrário e papel dono o atacante também poderia dar `DISABLE TRIGGER`). Fica registrado que o endurecimento real é papel da aplicação sem DDL (backlog, exige segredo novo).
- **P2 — exceção `_test` por nome do banco**: renomear o banco exige privilégio de dono; aceito e documentado.
- **P2 — rollback não removia o registro da migração**: runbook ajustado (DELETE do último registro em `drizzle.__drizzle_migrations`).
Não verificado pelo Codex (verificado por mim): restore do backup não usa TRUNCATE (cria tabelas) — `scripts/restore-test.sh` roda no próximo passo antes do deploy.
