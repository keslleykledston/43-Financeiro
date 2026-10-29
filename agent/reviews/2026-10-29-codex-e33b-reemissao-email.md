# Codex — E33b reemissão de boleto reenvia o e-mail de emissão (migração 0045)
Data: 2026-10-29 · Revisão read-only (Codex 1.0.4) do diff antes do deploy.

| # | Sev. | Achado | Tratamento |
|---|------|--------|------------|
| 1 | HIGH | Cancelamento concluindo enquanto o e-mail de emissão está `enviando` (SMTP fora da transação): o boleto cancelado ia no e-mail e a mensagem nova não era criada | `reopenEmissionAfterCancel` considera `enviado` OU `enviando`; teste novo. Resíduo LOW: se esse envio falhar e voltar a `pendente`, as duas mensagens saem (e-mail repetido, mas com o boleto certo) |
| 2 | MEDIUM | Rollback da migração sem caminho seguro | Migração aditiva e compatível com o código anterior: reverter só o código; linha 0045 de `docs/OPERACAO.md` reescrita |
| 3 | MEDIUM | `scheduleQueue` monta mapa `charge|kind|channel` com 2 linhas (linha escolhida indeterminada) | Lista ordenada por `generation`: a mais nova vence |
| 4 | INFO | Isolamento por empresa verificado; teste novo cobre só cobranças da mesma empresa | Aceito (o `INSERT…SELECT` filtra `company_id` e o vínculo composto da fila garante) |
