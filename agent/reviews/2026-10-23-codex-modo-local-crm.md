# Revisão Codex — modo local/CRM por empresa, 2026-10-23
Escopo: `companies.customer_mode`, regras de escrita por modo, sync, telas, migração 0007. Somente leitura.

| # | Prio | Achado | Status |
|---|------|--------|--------|
| 1 | P1 | Modo lido fora da transação: troca concorrente permitia gravar cliente em modo CRM (ou sync em LOCAL) | CORRIGIDO: trava advisory COMPARTILHADA nas escritas e EXCLUSIVA na troca; modo relido DENTRO da transação (create, update, archive, remover contato, CSV, sync, resolver conflito). Ordem fixa de travas `crm-sync → cust-mode`. Teste de corrida (25 iterações, checa ordem por xid) + teste de prévia velha no CSV. |
| 2 | P1 | `resolveConflict` (vincular) funcionava em modo LOCAL | CORRIGIDO: exige modo CRM no servidor (link e ignorar). Teste. |
| 3 | P2 | `getCustomerMode` exportada sem autorização | CORRIGIDO: `readCustomerMode` (interna) + `getCustomerMode(db, actor, company)` autorizada; páginas migradas. Teste. |
| 4 | obs | Sem constraint de domínio em `customer_mode` | CORRIGIDO: CHECK `('local','crm')` (migração 0008). Teste. |
Sem achados: autorização/empresa das actions, migração 0007 aditiva, auditoria sem PII, isolamento entre empresas.
Evidência: SANDBOX PASS — 62 unit/integração + 30 e2e. Observação honesta: o teste de corrida é uma guarda de regressão (probabilística), não uma prova formal; a garantia vem das travas.
