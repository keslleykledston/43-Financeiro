# Revisão Codex — E17 alertas de contratos (somente leitura, sem migração)
Resultado: 0 P0, 0 P1, 2 P2, 2 P3.
- P2 consulta de versões carregava a empresa toda → corrigido (filtra pelos contratos conferidos).
- P2 conversão de `decidedAt` para o dia de Manaus (hipótese; coluna é timestamptz, a conversão usa fuso explícito) → sem mudança; aceito.
- P3 referência do reajuste = data da APROVAÇÃO, não data efetiva do novo preço → decisão registrada em help/alertas-de-contratos.md e BACKLOG (índice/data efetiva ficam para depois).
- P3 testes de limite → adicionados (aniversário hoje, 60 dias exatos, 61 dias, fim na borda). Teste achou `-0` em `days` → corrigido com Math.abs.
Isolamento por empresa e permissão `contracts.read` confirmados; sem XSS (texto React).
