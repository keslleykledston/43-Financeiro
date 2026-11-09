# Revisão Codex — situação do cliente definida no sistema (migração 0058, `customers.status_locked`)

Resultado: sem CRITICAL/HIGH.
- MEDIUM: cliente travado ainda pode ser arquivado pelo CRM (inativo no CRM → arquivado). DECISÃO: aceito. Arquivar ≠ situação; se o CRM diz que deixou de ser cliente, o arquivamento vale (não gera cobrança). A trava vale só para ativo/suspenso/cancelado.
- LOW: validação de UUID frouxa em `setCustomerStatus` → corrigido (regex estrita).
Verificado pelo Codex: permissões (`crm.write`, `crm.reactivate` para voltar a ativo), isolamento por empresa, corrida com a sincronização (trava por empresa + CASE no UPDATE), faturabilidade, migração aditiva.
