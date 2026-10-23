# Deploy no host K3G — Nginx + Docker Compose

## Destino e política
Domínio pedido: `financeiro.devops.k3gsolutions.com.br`. **Não está comprovado que DNS aponte ao host**. Nginx está instalado **no host do usuário segundo seu relato**, não necessariamente no ambiente onde este documento foi criado. Não supor sudo nem exclusividade da máquina. App Next.js em Docker responde numa porta livre ligada somente a `127.0.0.1`; Nginx do host termina TLS e encaminha tráfego. PostgreSQL em network privada Compose sem mapeamento `ports`.

## Preflight (somente leitura)
`bash scripts/preflight.sh`. Verificar OS, privilégios, versões, serviços ativos, disco, RAM, portas e DNS, certificados disponíveis, `nginx -T` local sem salvar/exfiltrar segredo. Fazer inventário mínimo sem IP/credencial em `agent/memory/HOST_INVENTORY.md`.

## Plano de implantação
1. Escolher caminho isolado (ex. `/opt/k3g-finance`, se autorizado) e repo Git privado, owner não-root. Não utilizar `/var/www` ocupado sem verificar.
2. Criar `.env` fora do Git a partir de `.env.example`; gerar chaves/segredos no host com ferramenta criptograficamente segura, permissões 0600 e `umask 077`. Definir `NODE_ENV=production`, `APP_URL=https://financeiro.devops.k3gsolutions.com.br`, porta interna escolhida após preflight.
3. Criar Compose com `db`, `web`, `worker`; volume do postgres. Healthchecks, restart, recursos moderados, política logs, readiness e DB migrations controladas.
4. Testar app local `curl http://127.0.0.1:<porta>`; não expor em interface pública sem HTTPS.
5. Confirmar DNS com `dig +short financeiro.devops.k3gsolutions.com.br` e testar conectividade **sem declarar IPs em conversas**. Usar cert já existente válido ou ACME/Certbot de forma compatível com Nginx e políticas do host. DNS e portas 80/443 devem estar corretas.
6. Criar apenas um novo server block para domínio informado. Use `infra/nginx/financeiro.conf.template`; substituir porta correta, incluir TLS/cert válido, headers e HTTP→HTTPS. Faça backup do novo arquivo e de configs alteradas. `nginx -t` antes de `systemctl reload nginx`; nada de reinício indiscriminado.
7. Smoke: `curl -I https://financeiro.devops.k3gsolutions.com.br` + HTTP redirect + cert e browser; login e empresa autorizada. Se não passar, rollback vhost/release.
8. Migrar dados REAL somente por processo revisado com backups verificados, roles aprovadas e testes de consistência. Sandbox fica demo.

## HTTPS, proxy e headers
- HTTP→HTTPS, HSTS só depois de TLS realmente funcional e avaliação de subdomínios; X-Content-Type-Options, Referrer-Policy, CSP compatível com Next.js e evitando inline inseguro, limites de payload e timeouts. Endpoints de webhooks podem exigir limite diferente.
- Forward `Host`, `X-Forwarded-Proto`, `X-Forwarded-For` de forma controlada; Next/Auth precisa confiar apenas em proxy conhecido.
- Não habilitar Basic Auth permanente como substituto da autenticação real; pode ser defesa extra temporária no staging.

## Backup / rollback
Backup diário pg_dump + cópia criptografada fora do host de app quando possível, retenção acordada, restore periódico testado, backup pré-migration e rollback documentado de app + db. PostgreSQL stateful nunca perde volume no `docker compose down`; não usar `-v` em produção.

## Diagnóstico de bloqueios
Sem sudo/DNS/certificado → app em localhost com autenticação, documentação do comando exato/necessidade sem expor segredos; solicitar somente a ação essencial ao operador do host. Sem Docker → avaliação de instalação ou alternativa segura sem substituir serviços existentes. Sem Lovable MCP → frontend local não bloqueia.
