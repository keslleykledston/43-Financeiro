# Revisão Codex (somente leitura) — E10b-0 cliente HTTP da Cora (2026-10-28)
Escopo: `src/modules/providers/cora-http.ts`, `scripts/ops-cora-probe.ts`, `scripts/ops-cora-relabel.ts`, testes e `docker-compose.yml` (tools).

| Sev. | Achado | Tratamento |
|---|---|---|
| P1 | `READ_ONLY_ENVS` só `readonly` no TypeScript; em runtime um módulo poderia esvaziar a lista e liberar emissão em produção | Corrigido: `Object.freeze` na lista e nos hosts; teste prova que alterar lança erro |
| P2 | `code` do erro vinha cru do corpo da Cora e a sonda o imprimia (poderia ecoar token) | Corrigido: só identificador curto `[A-Za-z0-9_.:-]{1,60}`; texto livre é descartado; teste |
| P2 | `accepts()` do relabel sem prazo antes do handshake | Corrigido: prazo total de 10 s desde o início da conexão |
| — | Sem bypass de rota (traversal, %2e, barra dupla, maiúsculas, redirect); produção bloqueia POST antes da rede; mTLS com validação padrão do servidor e TLS ≥ 1.2; timeout 30 s e corpo ≤ 2 MB | Sem ação |
| nota | Guard de segredos cobre `src/`, não `scripts/` (os dois scripts precisam das credenciais) | Aceito: scripts rodam só no servidor, no container `tools` |
| nota | Codex não comentou o `docker-compose.yml` | `.env.credentials` é opcional e só no `tools`, com a mesma chave do web (conteúdo não lido) |

Sandbox após as correções: PASS (585 unit/int + 129 e2e). Também ajustado `tests/providers.test.ts` (rede só em smtp.ts e cora-http.ts, este só por `node:https`).
