# Revisão Codex — E10a motor de emissão SIMULADO (commit 9e85ec4)
Somente leitura; testes não executados pelo Codex. **Sem P0.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P1 | Corrida entre `reopenBatch` e a reserva do motor (locks diferentes): a reabertura podia passar com uma solicitação já "enviando" | **Corrigido**: `reopenBatch` toma o mesmo advisory lock `issuance:<empresa>` da reserva antes de checar os estados; ou a reserva já está confirmada (e a reabertura é recusada) ou espera. Teste de corrida **provado por mutação**. |
| 2 | P2 | Provedor injetado que se declare `mode: "mock"` contornaria o gate | **Corrigido**: `resolveProviders` é o ponto único e recusa qualquer injeção fora do executor de testes (`VITEST`); runtime só usa o registro. Usado no motor de emissão e nas mensagens. Teste. |
| 3 | P2 | `RangeError` gravava texto livre do provedor em `last_error` (possível dado do cliente) | **Corrigido**: só códigos curtos (`^[a-z0-9_]{1,40}$`); o resto vira `validacao_provedor`. Teste. |

Ponto não coberto pelo Codex, tratado por mim: rodada lenta que termina depois de o recuperador marcar `desconhecido` e outra rodada reconsultar/reemitir. Seguro por desenho **desde que o provedor honre a chave de idempotência** (e `record` só aplica a partir de `enviando`, sem sobrescrever `emitido`). Registrado como requisito de homologação em `docs/E10_GOLIVE.md` (idempotência e timeout do adaptador menor que `STUCK_MS`).

Verificado sem problema pelo Codex: CHECK de modo e `assertSimulated` antes de reservar, registry falha fechada, readiness só com `existsSync`, mocks sem rede, SQL cru por empresa, elegibilidade e revalidação antes do envio, SKIP LOCKED/advisory lock/chave fixa/reconsulta/backoff/limite diário, polling NFS-e fora do limite, RBAC, UI, migração 0017 e rollback.
