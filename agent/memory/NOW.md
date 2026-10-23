# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** Publicado: design Lovable portado (Tailwind 4, tokens claro/escuro, fontes locais, shell, /design-system), sandbox PASS (62 unit/int + 42 e2e). CRM: nome = K3G CRM; base https://api.k3gsolutions.com.br/api/; OpenAPI público em /openapi.json (corpos JsonValue, sem filtro incremental conhecido); endpoints /api/crm/companies, /contacts, /contracts, /invoices. Credenciais do CRM NÃO chegaram ao servidor (CRM_BASE_URL/CRM_API_TOKEN ausentes no .env atual) — aguardando usuário.

**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** (1) credenciais do CRM chegarem ao servidor (.env.crm ou nomes certos no .env); (2) rodar `pnpm crm:discover` (só estrutura, sem valores) p/ ver campos de companies/contracts; (3) K3gCrmAdapter + mapeamento + fixture no sandbox; (4) E04.0 finance/calc; E04 contratos.
**Bloqueios:** nenhum.
**Git:** branch main, sem push/tag.
