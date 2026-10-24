# Revisão Codex — E16 (central de ajuda /ajuda)

Data: 2026-10-24 · Escopo: renderizador Markdown próprio (`src/lib/markdown.tsx`), leitura de `help/*.md` (`src/modules/help/`), rotas `/ajuda`, botão "?", Dockerfile/.dockerignore.

Resultado: 0 P0, 0 P1, 0 P2, **1 P3**.
- P3: sem limite de tamanho ao ler artigos. **Corrigido:** artigo acima de 200 KB é ignorado (hoje todos somam ~40 KB).

Sem achado: path traversal (slug `[a-z0-9-]`), XSS (links só `x.md`/http(s), HTML vira texto), ReDoS, acesso sem login (middleware + requireContext), Docker (nenhum .env novo na imagem; só `help/`), build standalone (`/app/help`).
Sandbox: PASS 304 unit/int + 85 e2e (antes do P3; reteste final registrado no commit).
