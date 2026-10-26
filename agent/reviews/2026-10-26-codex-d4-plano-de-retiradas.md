# Revisão Codex — D4 plano de retiradas e previsão de lucro, 2026-10-26, somente leitura

Escopo: premissas (`profit_settings`, migração 0035), retirada planejada por sócio, cálculo puro da previsão, montagem da tela, permissões, isolamento.

**Resultado: 0 P0, 0 P1, 3 P2, 1 P3. Tratados como abaixo.** Codex não rodou testes (somente leitura); o sandbox rodou depois das correções.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | Contrato `ativo` com término passado inflava a previsão (cálculo ignora `end_at`) | Decisão mantida e agora explícita: a renovação automática de 12 meses é regra do negócio, então contrato vencido que segue ativo conta como renovado. A tela passa a AVISAR quantos são ("já passaram da data de término e foram tratados como renovados"). Teste de integração cobre o valor e o aviso |
| 2 | P2 | Soma/produto podia passar do inteiro seguro | Corrigido: `safe()` em receita, comissão e despesa; estoura com erro explícito (RangeError), nunca número errado. Teste unitário |
| 3 | P2 | Pessimista podia passar de 100% de imprevistos | Corrigido: teto de 100% também em imprevistos (inadimplência já tinha). Teste unitário |
| 4 | P3 | 36 consultas sequenciais ao montar a tela | Corrigido: os 12 meses de `pendingForecasts` rodam em paralelo (`Promise.all`) |

Sem achado: `partners.read`/`partners.manage` em toda leitura e gravação, `companyId` vindo do contexto validado, SQL parametrizado com filtro por empresa, upsert com `company_id` único, CHECKs da migração, defasagens X−1 (entrada) e X−2 (comissão), retenção, reserva/12, caixa acumulado, primeiro mês negativo, arredondamento, rollback documentado.
