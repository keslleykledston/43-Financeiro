# Revisão Codex — E04 contratos + calendário de faturamento, 2026-10-23
Escopo: commit e376e90 (contratos, versões/aprovação, calendário, feriados, migração 0010). Somente leitura; sem P0.

| # | Prio | Achado | Status |
|---|------|--------|--------|
| 1 | **P1** | `centsFromNumeric`/`numericFromCents` convertiam para `number` sem checar faixa segura; `numeric(18,2)` comporta valores que o `number` arredondaria (totais do calendário errados) | CORRIGIDO: teto `MAX_CENTS` = R$ 99.999.999.999,99 (somas de centenas de contratos ficam seguras); recusa na entrada; conversores lançam `RangeError`; CHECK no banco (migração 0011). Testes unit + integração (recusa pela app e pelo banco). |
| 2 | P2 | Reenvio de rascunho sobrescrevia `terms`/`requestedBy` da versão pendente (perda de histórico da trilha de aprovação) | CORRIGIDO: versão anterior vira `substituida` (imutável, com quem substituiu), nova versão pendente criada; auditoria registra `replaced`. Versão substituída não pode ser decidida. Teste. |
| 3 | P2 | Migração sem procedimento de reversão | CORRIGIDO: tabela de rollback por migração em `docs/OPERACAO.md` (0010, 0011) + regra de manter a tabela a cada migração. |
Sem achados nas demais áreas revisadas: isolamento por empresa e permissões, concorrência de aprovação (FOR UPDATE, uma pendente por índice parcial), calendário/datas, XSS/redirect/`erro`, PII na auditoria, comentários `//` engolindo cadeia Drizzle.
Não confirmado pelo Codex (apenas citado): possível deadlock por ordem inversa de locks contrato/versão; proteção CSRF das server actions é a do framework (Next valida Origin).
Evidência: SANDBOX PASS — 117 unit/integração + 44 e2e.
