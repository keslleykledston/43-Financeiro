# Codex — correção da baixa automática (achada no 1º pagamento real, Pix R$ 5,00) — sem migração
Data: 2026-10-29 · Revisão read-only (Codex 1.0.4) do diff antes do deploy.

Defeitos (produção, canário K3G TESTE): (a) `settle` testava `e.name === "Invalid"`, mas `Invalid extends Error {}` tem `name` "Error": a recusa "pagamento anterior à emissão" virou exceção, a transação foi desfeita e a baixa NÃO entrou; (b) o webhook marcava `processado/sem_mudanca` mesmo com falha (`failed>0` e `checked>0`).

| # | Sev. | Achado | Tratamento |
|---|------|--------|------------|
| 1 | — | Nenhum CRITICAL/HIGH | — |
| 2 | MEDIUM | Baixa automática sem limite inferior nem validação de calendário da data informada pela Cora (aceitaria `1900-01-01`) | Data precisa existir no calendário, não ser futura e não anterior ao 1º dia da competência da cobrança; senão vai para conferência. Testes (`1900-01-01`, `2026-02-31`) |
| 3 | INFO | `instanceof Invalid` não recupera erro SQL dentro da transação (propaga e a tx externa é desfeita) | Comportamento desejado |
| 4 | INFO | Retry do webhook com falha: até 5 tentativas e vira `erro` (ruído limitado, sem baixa repetida: chave idempotente) | Aceito |
Correções: `e instanceof Invalid`; baixa vinda da Cora (`via: cora_auto`) não aplica "pagamento anterior à emissão prevista" (a data é a da Cora; boleto pode ser emitido antes da data prevista); webhook relança quando `failed > 0`.
