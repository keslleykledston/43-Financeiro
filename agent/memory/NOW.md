# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** TUDO em Docker (db privado + web 127.0.0.1:3150 + profile tools). health OK, migração aplicada, 1 teste passa no container. Sem auth/UI de negócio/Nginx.
**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** seed admin (docker compose --profile tools run --rm -e SEED_ADMIN_EMAIL -e SEED_ADMIN_PASSWORD tools pnpm seed), Auth.js + argon2, shell iOS + dashboard DEMO. Depois vhost Nginx (autorizado; exige sudo).
**Bloqueios:** vhost Nginx/HTTPS exige sudo e aprovação (host compartilhado). Ver HOST_INVENTORY.md.
**Git:** branch main, sem push/tag.
