# Revisão Codex — E12 painel executivo (commit 7906b25)
Somente leitura; testes não executados pelo Codex. **Sem P0.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P1 | Cobrança só em PRÉVIA (lote rascunho) fazia o item sumir da previsão: saía de "previsto por contrato" e ainda não entrava em "confirmado" | **Corrigido**: o previsto só é suprimido quando existe cobrança APROVADA em lote aprovado para o mesmo contrato+competência; prévia continua "prevista". Teste: prévia → ainda previsto; aprovar → confirmado, sem dobrar. |
| 2 | P2 | Tela "Recebimentos" calculava o total sobre a lista limitada a 500; o KPI usa a soma completa | **Corrigido**: total por SQL sem limite (bate com o KPI, teste) e aviso quando a lista é truncada. |
| 3 | P2 | `loadScheduled` repetido ~7× por empresa (contratos e feriados relidos) e grupo em série | **Corrigido**: `loadScheduledMany` lê contratos/feriados uma vez; empresas do grupo em paralelo. `loadScheduled` (usado pelos lotes) passou a delegar a ele, mesmo resultado. |

Verificado sem problema pelo Codex: isolamento (finance.read por empresa, grupo empresa a empresa, `?visao=grupo` não amplia acesso, SQL cru por `company_id`), RBAC por bloco e admin técnico sem números, correção financeira (a receber/vencido/emitido/recebido/previsão, conservação), intercompany fora de receita, datas/fuso, alertas, UI/acessibilidade, banner honesto.
Ressalva registrada na ajuda: "se anulam no saldo consolidado" só vale quando os dois lados da transferência estão importados e classificados.
