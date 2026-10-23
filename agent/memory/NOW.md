# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** E00 parcial. Preflight rodou; scaffold Next.js criado; `pnpm typecheck`, `pnpm test` (1 smoke) e `pnpm build` PASSAM. Sem auth, sem DB subido, sem UI de negócio, sem Nginx/HTTPS.
**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** subir Postgres via compose (definir POSTGRES_* no .env privado), schema Drizzle identity (users/companies/memberships/audit), Auth.js credentials + argon2, shell iOS-like.
**Bloqueios:** vhost Nginx/HTTPS exige sudo e aprovação (host compartilhado). Ver HOST_INVENTORY.md.
**Git:** branch main, sem push/tag.
