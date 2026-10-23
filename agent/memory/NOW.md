# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** Docker (db+web). Login Auth.js+argon2, middleware, shell (sidebar+bottom nav), seletor de empresa validado no servidor, dashboard DEMO, 6 placeholders. Anônimo -> 307 /login (curl). 2 testes unit passam. NÃO testado: login com senha real (usuário valida no browser), e2e, mobile 375px, Nginx/HTTPS.
**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** usuário valida login em http://127.0.0.1:3150 (túnel SSH). Depois: Playwright smoke, AUTH_URL com domínio, vhost Nginx (autorizado, exige sudo), E02 RBAC/convites.
**Bloqueios:** vhost Nginx/HTTPS exige sudo e aprovação (host compartilhado). Ver HOST_INVENTORY.md.
**Git:** branch main, sem push/tag.
