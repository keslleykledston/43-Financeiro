# Revisão Codex — E21 (aditivos, comentários, dados da empresa), 2026-10-24

Somente leitura. Leu serviços, actions, páginas, schema, migração 0025, testes e ajuda. Sem achado de IDOR entre empresas, vazamento de texto no audit, XSS/injeção nem regressão em rascunho/rejeição/alertas.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P1 | `proposeAndApprove` gravava a proposta e aprovava em transações separadas: falha na aprovação deixava a alteração pendente para outra pessoa aprovar. | CORRIGIDO: proposta + aprovação na mesma transação (`contracts/service.ts`). |
| 2 | P2 | Trigger de `notes` não cobre `TRUNCATE`. | ACEITO: mesmo desenho das outras tabelas só-de-acréscimo (comissões, cancelamentos). Um trigger de TRUNCATE quebraria os `truncate ... cascade` dos testes; a proteção real é o papel do banco (aplicação sem TRUNCATE) — item de endurecimento do papel de runtime no backlog. |
