# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** CRM = K3G CRM conectado (leitura): token válido, IP liberado. Adaptador real `K3gCrmAdapter` (crm/companies) + 15 testes + fake no formato real; SANDBOX PASS (70 unit/int + 42 e2e). Simulação real só com contagens: 42 clientes ACTIVE entrariam, 0 conflitos. CONTRATOS: 0 no CRM (endpoints vazios). Sync real DESLIGADO em prod; ambas as empresas em modo LOCAL. Design Lovable portado e publicado.

**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** (1) usuário confirma regra de status (ACTIVE=cliente) e a qual empresa pertencem os clientes; (2) usuário autoriza import real: CRM_SYNC_ENABLED=true + modo CRM + ativar conexão + revisar prévia; (3) descobrir onde estão os CONTRATOS (CRM vazio) antes do E04; (4) revisão Codex do adaptador; E04.0 finance/calc.
**Bloqueios:** nenhum.
**Git:** branch main, sem push/tag.
