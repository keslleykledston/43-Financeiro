# Revisão Codex — E20 cancelar boleto (migração 0024)
Resultado: 2 P1, 2 P2, 1 P3 — todos tratados.
- P1 TOCTOU pagamento × cancelamento (a chamada ao provedor corre fora da transação) → o reservar trava a cobrança (FOR UPDATE, a mesma trava da baixa) e `recordPaymentTx` recusa baixa enquanto houver cancelamento `enviando`/`desconhecido`. Testes: baixa durante a chamada e durante "sem resposta".
- P1 reconsulta concorrente duplicava tentativas → registro final com compare-and-set pelo nº da tentativa: só vale a mais recente; a anterior é descartada. Teste com a primeira pendurada no provedor.
- P2 `created_at` mutável → incluído no trigger (migração ainda não aplicada em produção, editada antes do deploy). Teste.
- P2 boleto pago no provedor deixava a régua ativa e sem pendência → para a régua da cobrança, evento próprio `boleto.paid_at_provider` e aviso na tela pedindo a baixa. (Reconciliação automática vem com o adaptador real, E10b.)
- P3 clique duplo → `PendingButton` (useFormStatus) nos botões de cancelar e reconsultar.
Confirmado correto: permissão só diretoria, isolamento por empresa (inclusive SQL cru), chave de idempotência por geração, auditoria sem motivo nem dados do cliente, nenhum caminho que movimente dinheiro.
