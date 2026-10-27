# Revisão Codex (somente leitura) — D4b (previsto × realizado) e relatório de despesas por categoria

**D4b** (`plan-calc.ts buildVariance`, `plan.ts`, página do plano): 0 P0, 0 P1, 0 P2. Confirmado: queries com `company_id`, rascunho/cancelada/rejeitada fora, mês corrente parcial fora dos totais, inteiro seguro.

**Relatório** (`payables/report.ts`, página e exportação CSV): 0 P0/P1; 2 P2 corrigidos:
- parâmetros `de/ate/base` inválidos eram trocados pelo padrão em silêncio → agora recusa (vazio = padrão);
- soma acima do limite derrubava a tela/exportação (500) → erro claro "Valores acima do limite suportado".
Sem achado: isolamento por empresa, permissões (`payables.read` ver / `payables.export` baixar), SQL e CSV (fórmulas neutralizadas pelo `toCsv`), fronteiras de mês, estorno e status.
