# Revisão Codex — D3b aplicar o histórico de despesas, 2026-10-26, somente leitura

Escopo: `apply.ts` (aplicação e recorrentes), migração 0036 (`expense_applications`, uniques, gatilho), `history.ts` (trava do "Desfazer"), script de operação, cartão da tela, testes.

**Resultado: 0 P0, 0 P1, 3 P2, 1 P3.** Codex não rodou testes (somente leitura); o sandbox rodou depois das correções.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | `proposeRecurring` gravava cada modelo/série em transação própria (falha no meio deixava metade) e podia duplicar por descrição repetida | Corrigido: tudo numa transação (modelos, séries e auditoria) e o conjunto de descrições é atualizado a cada criação |
| 2 | P2 | `row_id` apontava para a linha do staging sem `company_id` | Corrigido: `UNIQUE(company_id,id)` em `expense_import_rows` e FK composta `(company_id,row_id)` (migração 0036 regerada antes de qualquer deploy) |
| 3 | P2 | Gatilho por linha não cobre `TRUNCATE` | **Aceito**, como no H1, E21 e D3: o `TRUNCATE ... CASCADE` limpa o banco de teste e exige dono da tabela; mitigação operacional (backup antes; restore validado) |
| 4 | P3 | `applicationStatus` somava aplicações de importações antigas | Corrigido: conta só as linhas da importação atual |

Sem achado: concorrência/idempotência (advisory lock por empresa + índice único por linha; `d3b:<linha>` em tabelas diferentes não colide), permissões (`history.import`, `partners.manage`, `payables.manage`, `payables.pay`; leitura `partners.read`), datas e valores de `buildApplyPlan`, ordem das statements da migração, isolamento por empresa.
