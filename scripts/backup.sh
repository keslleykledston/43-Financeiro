#!/usr/bin/env bash
# Backup pg_dump comprimido do K3G Finance (roda no container db). Retenção: 14 dias.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/home/suporte/backups/k3g-finance}"
umask 077; mkdir -p "$DEST"
OUT="$DEST/k3gfinance-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d k3gfinance --no-owner' | gzip > "$OUT"
gzip -t "$OUT" && [ "$(stat -c %s "$OUT")" -gt 1000 ] || { echo "backup inválido: $OUT" >&2; rm -f "$OUT"; exit 1; }
sha256sum "$OUT" > "$OUT.sha256"
find "$DEST" -name 'k3gfinance-*' -mtime +14 -delete
echo "$OUT"
