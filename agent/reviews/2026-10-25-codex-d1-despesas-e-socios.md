# Revisão Codex — D1 despesas e sócios (2026-10-25, somente leitura)

Escopo: categorias, centros de custo, sócios, conta-corrente dos sócios (retiradas), extensão de contas a pagar, migração 0032, telas.

**Resultado: 0 P0, 2 P1, 3 P2. Todos tratados.**

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P1 | Estorno concorrente: o UPDATE não exigia `status='ativo'` e podia sobrescrever motivo/autor do primeiro estorno | Corrigido: `WHERE ... AND status='ativo' RETURNING` e exige 1 linha; teste com dois estornos simultâneos (um só vale) |
| 2 | P1 | Linha de rollback da 0032 perdia dados e não reinstalava a função da 0018 | Corrigido: caminho seguro = restaurar o backup anterior; reversão só de esquema documentada com `CREATE OR REPLACE FUNCTION payables_guard()` da 0018 (docs/OPERACAO.md) |
| 3 | P2 | CHECK de estorno aceitava motivo vazio/espaços | Corrigido na migração (ainda não implantada, regenerada): `char_length(btrim(reverse_reason)) >= 3`; teste direto no banco |
| 4 | P2 | `ensureExpenseDefaults` podia falhar/duplicar na primeira leitura simultânea | Corrigido: advisory lock por empresa + conferência após o lock; teste com 4 leituras simultâneas |
| 5 | P2 | Sem teste do CSV de contas a pagar | Corrigido: teste da ordem das colunas (novas no fim) e da neutralização de fórmula em categoria/centro |
| — | nota | `requestKey` com reenvio concorrente podia dar erro de unicidade | Corrigido: captura do 23505 e devolve o lançamento existente; teste com 3 envios simultâneos |

Sem achado: isolamento entre empresas (FKs compostas e filtros), autorização (partners.* só diretoria), auditoria sem valores/descrições, sinais e SQL do saldo, guard de `payables` (nada regrediu em relação à 0018), telas sem HTML bruto, nenhum caminho de pagamento real.
