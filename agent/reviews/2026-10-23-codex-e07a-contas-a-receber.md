# Revisão Codex — E07a contas a receber (commit 4b53b79)
Somente leitura; testes não executados pelo Codex. **Sem P0.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P1 | `reopenBatch` checava pagamentos antes de travar as cobranças: uma baixa concorrente podia perder a corrida | **Corrigido**: trava as cobranças do lote (mesma ordem da baixa: cobrança → pagamento) antes de checar; **e** trigger `charges_payments_guard` no banco impede cobrança com pagamento/estorno sair de "aprovada" ou mudar de valor. Teste de corrida **provado por mutação**. |
| 2 | P1 | Trigger não tornava o estorno imutável (UPDATE de estornado passava; reativar limpando metadados; metadados parciais em ativo) | **Corrigido** (migração 0015 regenerada, ainda não implantada): `payments_guard` só deixa nascer ATIVO, ativo só vira estornado sem tocar valor/data/forma/cobrança, estornado é imutável, DELETE proibido; CHECK estrito (estornado ⇔ três metadados; ativo ⇔ nenhum). Testes novos. |
| 3 | P2 | Corrida de `request_key` em cobranças diferentes dava erro bruto | **Corrigido**: trata `23505` do índice, relê a chave e devolve duplicata ou "chave já usada". Teste. |
| 4 | P2 | `2026-02-31` virava `RangeError` (500) em pagamento/filtros (e igual em `generateBatch`) | **Corrigido**: `src/lib/iso-date.ts` sem exceção, usado nos dois módulos. Teste. |
| 5 | P2 | CSV injection com espaço/tab antes de `=+-@` | **Corrigido** em `src/lib/csv.ts` (`^\s*[=+\-@\t\r]`). Teste. |
| 6 | P2 | Help dizia que contabilidade registra pagamento | **Corrigido** (só diretoria, gerente e assistente). |

Verificado sem problema pelo Codex: centavos/teto, ordem de locks baixa×estorno (sem deadlock), FK impede apagar cobrança com pagamento, isolamento por empresa em todo SQL cru, RBAC em páginas/ações/exportação, filtros parametrizados, datas e fuso, auditoria sem valores/nomes, XSS, parada da régua ao quitar.
