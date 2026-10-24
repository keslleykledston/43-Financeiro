# Revisão Codex — E18 comissão de parceiros (migração 0022)
Resultado: 2 P1, 5 P2, 1 P3 — todos tratados (ou documentados).
- P1 mudar/remover parceiro ou percentual antes do fechamento sumia com recebimentos já qualificados → `setContractCommission` bloqueia a mudança (parceiro ou % já definido) enquanto houver cobrança quitada fora de fechamento; completar o % que faltava é livre. Teste.
- P1 trigger deixava anular linha sem cancelar o fechamento → só se anula linha com fechamento `cancelado` (serviço cancela o fechamento antes). Teste no banco.
- P2 fechamento pago/cancelado não era imutável em todos os campos → trigger compara status, paid_*, cancel_* inteiros. Teste.
- P2 estorno depois do pagamento sem fluxo → aviso na tela e no help (acerto manual no próximo pagamento); lançamento de acerto fica no BACKLOG.
- P2 fronteiras de mês/fuso → testes (quitação dividida, 1º/último dia, estorno + nova quitação). `paid_at` é `date`, sem fuso.
- P2 cobrança cancelada após fechamento → aviso também para `charges.status <> 'aprovada'` (na prática o banco já impede cancelar cobrança com baixa: `charge_has_payments`).
- P2 auditoria com total em centavos → removido (só ids, mês, contagem).
- P3 UPDATE do fechamento sem company_id → incluído.
Teste novo de corrida: 3 fechamentos simultâneos geram 1 fechamento.
