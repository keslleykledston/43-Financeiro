#!/usr/bin/env bash
# Valida um backup restaurando em banco TEMPORÁRIO (nunca toca k3gfinance).
set -euo pipefail
cd "$(dirname "$0")/.."
F="${1:?uso: restore-test.sh arquivo.sql.gz}"
sha256sum -c "$F.sha256" >/dev/null
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "DROP DATABASE IF EXISTS restore_check" -c "CREATE DATABASE restore_check"'
gunzip -c "$F" | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d restore_check -q -v ON_ERROR_STOP=1' >/dev/null
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d restore_check -tAc "select count(*) from users"' | sed 's/^/usuários restaurados: /'
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -qc "DROP DATABASE restore_check"'
echo "restore OK"
