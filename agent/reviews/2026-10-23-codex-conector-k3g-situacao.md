# Revisão Codex — conector K3G CRM + situação do cliente, 2026-10-23
Escopo: commits b9a9d6c e 0cb4c55 (adaptador real, http, factory, sync, situação, scripts crm-*, UI).

| # | Prio | Achado | Status |
|---|------|--------|--------|
| 1 | **P1** | `resolveConflict`: um comentário `//` na mesma linha engoliu o `.where(...)` do UPDATE → atualizava conflitos de TODAS as empresas (apagava payload, mudava status) | CORRIGIDO: `.where(id AND companyId)`. Teste de isolamento entre 2 empresas; **provado por mutação** (com o bug reintroduzido o teste falha: `expected 'ignored' to be 'open'`). Varredura do mesmo padrão em src/scripts: nenhuma outra ocorrência. Sem efeito em produção (0 conflitos). |
| 2 | P2 | Sem allowlist de destino do token; HTTP liberável por env em produção | CORRIGIDO: `CRM_ALLOWED_HOSTS` (padrão api.k3gsolutions.com.br); domínio real NUNCA por HTTP; HTTP só com opt-in e host interno sem ponto. Testes (sufixo enganoso, 169.254.169.254, http+flag). |
| 3 | P2 | Assistente podia reativar cliente cancelado→ativo (volta a faturar) | CORRIGIDO: permissão `crm.reactivate` (diretoria, gerente); reduzir cobrança segue livre; auditado. Teste. |
| 4 | P2 | Payload de conflito (nome+documento) visível a qualquer `crm.read` | CORRIGIDO: `listConflicts` exige crm.write + integrations.manage (diretoria). Teste. Retenção: payload apagado ao resolver; conflitos abertos mantêm nome+documento até serem resolvidos (necessário para decidir). |
| 5 | P2 | `crm-discover` imprimia texto livre de erro do provedor | CORRIGIDO: só status HTTP. |
Sem achados: token só server-side (sem NEXT_PUBLIC_, nada em client components), redirects bloqueados, lógica de situação/planHash, PROSPECT nunca importado, contatos do CRM `isFinancial=false` fora da exportação financeira, scripts crm-* sem valores, migração 0009, travas de modo, isolamento nas demais consultas.
Evidência: SANDBOX PASS — 78 unit/integração + 42 e2e.
Lição de processo: patch automático (python) apendou comentário no fim de linha de uma cadeia Drizzle; adotar revisão do diff de cada patch mecânico e teste de isolamento entre DOIS tenants em toda escrita com UPDATE.
