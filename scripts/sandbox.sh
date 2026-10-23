#!/usr/bin/env bash
# Gate de validação ponta a ponta, 100% isolado (projeto k3g-sandbox). Nunca toca produção.
# Etapas: build -> db -> migrate -> typecheck -> unit+integração -> seed -> web -> e2e (Playwright).
set -euo pipefail
cd "$(dirname "$0")/.."
C=(docker compose -p k3g-sandbox -f docker-compose.sandbox.yml)
cleanup() { "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
step() { printf '\n== %s ==\n' "$*"; }
rm -rf e2e-results; cleanup
step "build";            "${C[@]}" build sandbox-web sandbox-tools
step "db";               "${C[@]}" up -d --wait sandbox-db
step "migrate";          "${C[@]}" run --rm sandbox-tools pnpm db:migrate
step "typecheck";        "${C[@]}" run --rm sandbox-tools pnpm typecheck
step "unit+integração";  "${C[@]}" run --rm sandbox-tools pnpm test
step "seed";             "${C[@]}" run --rm sandbox-tools pnpm seed
step "web";              "${C[@]}" up -d --wait sandbox-web
step "e2e (Playwright)"; "${C[@]}" run --rm sandbox-e2e
printf '\nSANDBOX PASS  (relatório: e2e-results/report/index.html)\n'
