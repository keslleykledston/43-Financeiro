#!/usr/bin/env bash
# Preflight READ-ONLY — sem segredos, sem mudanças no host.
set -u
printf '\n== K3G Finance / preflight somente leitura ==\n'
printf 'Data UTC: '; date -u '+%Y-%m-%dT%H:%M:%SZ'
printf 'SO: '; uname -srm
if [ -r /etc/os-release ]; then grep -E '^(NAME|VERSION_ID)=' /etc/os-release | head -2; fi
printf '\n== ferramentas ==\n'
for cmd in git node npm pnpm docker nginx curl dig certbot codex claude; do
  if command -v "$cmd" >/dev/null 2>&1; then printf '%-9s presente\n' "$cmd"; else printf '%-9s ausente\n' "$cmd"; fi
done
printf '\n== recursos ==\n'
command -v df >/dev/null && df -h . | tail -1
command -v free >/dev/null && free -h | head -2
printf '\n== listeners locais: somente portas/processos (não exportar log integral) ==\n'
if command -v ss >/dev/null 2>&1; then ss -ltnH 2>/dev/null | awk '{print $4}' | sed -E 's/^.*:([0-9]+)$/porta \1/' | sort -u | head -25; fi
printf '\n== nginx (teste sem alterações) ==\n'
if command -v nginx >/dev/null 2>&1; then nginx -t 2>&1 | sed -E 's/(password|secret|token)=\S+/\1=[REDACTED]/g' | head -10; fi
printf '\n== DNS (consulta apenas; não publicar IP em tickets) ==\n'
if command -v dig >/dev/null 2>&1; then
 count=$(dig +short financeiro.devops.k3gsolutions.com.br A | awk 'NF{n++} END{print n+0}')
 printf 'Registros IPv4 encontrados: %s\n' "$count"
else printf 'dig indisponível\n'; fi
printf '\n== Observação ==\nNenhuma configuração foi alterada. Nunca cole conteúdo de .env, nginx -T ou chaves privadas em chat.\n'
