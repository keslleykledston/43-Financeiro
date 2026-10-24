# Revisão Codex — E11a contas a pagar (commit 4e6ed35)
Somente leitura; testes não executados pelo Codex. **Sem P0 e sem P1.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P2 | A checagem de duplicidade provável (mesmo fornecedor, valor e vencimento) não tinha lock: dois lançamentos simultâneos podiam passar | **Corrigido**: advisory lock por (empresa, fornecedor) em criar e editar. Teste de concorrência (3 lançamentos iguais → só 1 passa sem confirmação). |
| 2 | P2 | Nº do documento diferenciava caixa (`NF-1` × `nf-1`) | **Corrigido**: índice único sobre `lower(document_number)` e espaços colapsados/aparados. Teste. Migração 0018 regenerada (ainda não implantada). |

Verificado sem problema pelo Codex: alçada do gerente, segregação (diretoria só com chave ligada e auditada), valor/fornecedor imutáveis após o rascunho (serviço e trigger), máquina de estados e nada se apaga no banco, baixa só em conta aprovada com teto, ordem de locks conta → baixa, cancelamento bloqueado com histórico de baixas, isolamento por empresa e RBAC em páginas/ações/exportação, CSV protegido, auditoria sem dados, idempotência, painel (saídas, conservação, grupo), UI sem HTML bruto, migração e rollback.
