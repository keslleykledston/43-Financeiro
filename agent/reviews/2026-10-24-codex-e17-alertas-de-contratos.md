# Revisão Codex — E17 alertas de contratos (somente leitura, sem migração)
Resultado: 0 P0, 0 P1, 2 P2, 2 P3.
- P2 consulta de versões carregava a empresa toda → corrigido (filtra pelos contratos conferidos).
- P2 conversão de `decidedAt` para o dia de Manaus (hipótese; coluna é timestamptz, a conversão usa fuso explícito) → sem mudança; aceito.
- P3 referência do reajuste = data da APROVAÇÃO, não data efetiva do novo preço → decisão registrada em help/alertas-de-contratos.md e BACKLOG (índice/data efetiva ficam para depois).
- P3 testes de limite → adicionados (aniversário hoje, 60 dias exatos, 61 dias, fim na borda). Teste achou `-0` em `days` → corrigido com Math.abs.
Isolamento por empresa e permissão `contracts.read` confirmados; sem XSS (texto React).

## Segunda rodada — regra "12 meses, renova sozinho" (dono, 2026-10-24)
Resultado: 0 P0, 0 P1, 3 P2, 1 P3 — todos corrigidos.
- P2 fusão renovação+reajuste falhava no próprio dia (gerava renovação + reajuste em atraso) → fusão inclui hoje.
- P2 suspenso não recebia aviso de renovação → agora recebe (suspensão não encerra o contrato); reajuste continua só para ativo. Decisão de negócio assumida; confirmar com o dono.
- P2 `endAt` igual ao aniversário ainda gerava reajuste → `endAt > due` (e testado).
- P3 texto "cliente encerra" → "cliente (ou a K3G)".
Sem impacto em isContractBillable/faturamento.
