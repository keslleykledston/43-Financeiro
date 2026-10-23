# Revisão Codex — E09a provedores simulados + janela + agendador (commit 677fa85)
Somente leitura; testes não executados pelo Codex. **Sem P0.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P1 | `processQueue`/`runScheduled`/`tickAll` aceitam `Providers` injetado, que contornava o gate das chaves `*_LIVE_ENABLED` | **Corrigido**: `assertSimulated` roda sempre (injetado ou não): chave real ligada ou qualquer provedor com `mode != "mock"` → `LiveNotAvailable`. Testes novos (dispatch + providers). |
| 2 | P2 | CHECK de `weekdays` aceita repetidos (`'{1,1}'`) | **Aceito**: a aplicação normaliza; duplicata no banco é inofensiva (`includes`). CHECK com subconsulta não é permitido no Postgres; função auxiliar não compensa. |

Verificado sem problema pelo Codex: nada sai da máquina (mocks sem rede), kill switch e automático, janela/fuso/limites/tolerância, retentativas e duplicidade (chave `msg-<id>`, FOR UPDATE, lock por empresa), isolamento/RBAC, PII em logs/auditoria, validação, regressão do `scheduleQueue`.
Observação aceita: o serviço `scheduler` recebe os mesmos `env_file` do app (credenciais do banco/Auth). O código dele só usa o banco; no E10, avaliar um env_file mínimo para o agendador. Chamada ao provedor dentro da transação é válida só para mocks (comentado no código; E10 deve usar reservar → enviar → registrar).
