# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** scaffold OK (typecheck/test/build). Postgres 16 healthy via compose (dev: 127.0.0.1:5440). Migração 0000 aplicada: users, companies, memberships, audit_log. Sem auth, sem UI de negócio, sem Nginx/HTTPS.
**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** Auth.js credentials + argon2, seed de usuário admin via script (senha fora do chat), shell iOS-like + dashboard DEMO, testes de acesso anônimo bloqueado. Depois vhost Nginx (usuário AUTORIZOU em 2026-10-22; exige sudo e remover deny de nginx/sudo em .claude/settings.json).
**Bloqueios:** vhost Nginx/HTTPS exige sudo e aprovação (host compartilhado). Ver HOST_INVENTORY.md.
**Git:** branch main, sem push/tag.
