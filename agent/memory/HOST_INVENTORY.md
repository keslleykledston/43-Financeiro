# Inventário do host (sem dados sensíveis) — 2026-10-22
- Ubuntu 24.04, 30 GiB RAM (~9.6 GiB livres), /data 89% usado (48G livres).
- Presentes: git, node 22, npm, pnpm 10, docker 29 + compose 5, nginx, certbot, dig, codex, claude.
- Host compartilhado: dezenas de listeners e vhosts Nginx de outros projetos. NÃO alterar nginx global.
- DNS financeiro.devops.k3gsolutions.com.br: 1 registro A encontrado (não verificado se aponta a este host).
- Portas: 3100/3101/5433 ocupadas. Reservada para este app: web 127.0.0.1:3150. DB sem `ports` (rede Docker privada).
- Nginx: vhost novo NÃO criado (requer sudo/aprovação). Template em infra/nginx/.
