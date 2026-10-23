# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** 1ª sincronização real (2026-10-23 02:16) NÃO importou nada: a conexão tinha companyRef preenchido (14 caracteres, provável CNPJ) e o K3G CRM não informa empresa por cliente → 122 conflitos "ambiguous_company", 0 criados. Causa: texto da tela induziu o preenchimento + motor gerava conflito até para prospects e não encerrava conflitos obsoletos. CORRIGIDO e publicado (prospect só é ignorado; conflitos que deixam de valer viram `obsolete` e perdem o payload; aviso na prévia quando só há conflitos; rótulo do campo). companyRef limpo em prod (ops, auditado). Clientes no banco: 0; 122 conflitos antigos abertos serão encerrados na próxima aplicação. Plano atual: 63 novos + 1 conflito (CNPJ duplicado no CRM) + 58 ignorados (prospects) + 24 inválidos. SANDBOX PASS (79 unit/int + 42 e2e).

**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** usuário refaz Integrações → Revisar → Confirmar e aplicar (deve mostrar 63 novos); depois resolver o 1 conflito; E04.0 finance/calc + E04 contratos locais.
**Bloqueios:** nenhum.
**Git:** branch main, sem push/tag.
