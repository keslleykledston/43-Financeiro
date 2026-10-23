# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** Publicado. Situação do cliente (ativo/suspenso/cancelado) + só ativo faturável; mapeamento K3G (ACTIVE/INACTIVE/CHURNED; PROSPECT ignorado). CRM_SYNC_ENABLED=true ligado em prod (ordem do dono); as duas empresas ainda em modo LOCAL, 0 clientes, nenhuma conexão ativada — NADA importado. Simulação real (contagens): 64 clientes (63 entram + 1 conflito por CNPJ duplicado no CRM). SANDBOX PASS (74 unit/int + 42 e2e). Contratos serão cadastrados no Finance (E04).

**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** (1) diretoria: Integrações → K3G Solutions modo CRM → ativar conexão → revisar prévia → confirmar (primeira importação real); K3G Call segue local; (2) revisão Codex do adaptador/situação; (3) E04.0 finance/calc + E04 contratos locais.
**Bloqueios:** nenhum.
**Git:** branch main, sem push/tag.
