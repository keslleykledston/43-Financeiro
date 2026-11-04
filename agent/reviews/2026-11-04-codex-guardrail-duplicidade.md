# Codex — guardrail de duplicidade de boletos (2026-11-04)
Escopo: `cora-boleto.ts` (conferência ampliada, `knownKeys`), `issuance/service.ts` (devolução de vaga, laço de passadas, `retryDuplicate`, `duplicateAlerts`), páginas de emissões e do lote.
Resultado: 0 CRITICAL, 1 HIGH, 1 MEDIUM, 1 LOW.
- HIGH («devolver a vaga permite passar do canário/limite sob concorrência»): análise — a reserva recontaa `claimed_at is not null and attempts > 0` SOB o lock da empresa a cada passada; só a solicitação que NÃO emitiu nada (alerta) devolve a vaga, então o total de reservas que emitem nunca passa do teto. Prova: teste «GUARDRAIL × CONCORRÊNCIA» (3 rodadas simultâneas, 4 clientes, 1 com alerta) → no máximo 3 POSTs, nenhum cliente emitido duas vezes. Sem mudança de código; teste adicionado.
- MEDIUM (corrigido): passadas esgotadas com alertas → `waiting` avisa «processe de novo».
- LOW (corrigido): faixa de produção descrevia a regra antiga («boleto igual»).
Sem bypass do guardrail para a mesma solicitação; `retryDuplicate` mantém a chave de idempotência; `knownKeys` só do mesmo cliente/vencimento e estados emitido/enviando/desconhecido.
