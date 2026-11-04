# Codex — «Cancelar solicitações pendentes» no painel (2026-11-04)
Escopo: `cancelPendingBoletos`/`openBoletoRequests` (issuance/service.ts), `cancelPendingRequests` (panel.ts), botão no painel.
Resultado: 0 CRITICAL/HIGH/MEDIUM, 1 LOW.
- LOW (corrigido): o botão aparecia com `issuance.manage` mas a ação exige `issuance.request`; agora a exibição usa `can(role, "issuance.request")`.
- Lacuna de teste aceita: não há teste de que `enviando`/`desconhecido` sobrevivem ao cancelamento nem da corrida reserva × cancelamento (o UPDATE exige status pendente, attempts 0 e external_ref nulo, sob o mesmo lock da reserva).
