# Revisão Codex (somente leitura) — E10b-3/4/5: dados do boleto, baixa automática e webhooks da Cora de TESTES (2026-10-28)
Escopo: `issuance/{sync,webhooks,boleto-details}.ts`, rota pública `/api/v1/webhooks/cora/[secret]`, `cora-http.ts` (rotas `/endpoints`), `cora-boleto.ts`, migração 0043, telas de Emissões/Integrações/Cobrança, agendador.
Veredito inicial: **BLOQUEIA** (1 P1). Após as correções: sem P0/P1 abertos.

| Sev. | Achado | Tratamento |
|---|---|---|
| — | Nenhum caminho para emitir/cancelar/pagar/transferir na Cora de PRODUÇÃO; locks na mesma ordem (sem deadlock); consulta à Cora fora da transação; isolamento por empresa | Confirmado pelo Codex |
| P1 | Rota pública do webhook permitia crescimento sem limite da fila de eventos | Corrigido: índices únicos (evento por id; um pendente por boleto/tipo) + ON CONFLICT DO NOTHING, teto de 1.000 pendentes por empresa, expurgo de eventos concluídos após 30 dias |
| P2 | Após estorno da baixa automática, nova rodada marcava como baixado (chave fixa devolvia o pagamento estornado) | Corrigido: baixa duplicada/estornada vai para conferência (`baixa_anterior_estornada`), `settled_at` não é marcado |
| P2 | Faltavam validações antes da baixa (valor bruto do boleto, data ausente/futura virava "hoje") | Corrigido: `valor_do_boleto_diferente_da_cobranca` e `data_do_pagamento_ausente_ou_futura` vão para conferência; nunca ajusta data |
| P2 | Deduplicação concorrente de avisos | Corrigido (índice único parcial) |
| P2 | Rotação do webhook podia deixar a empresa sem segredo válido | Corrigido: cria os novos avisos, grava o hash e só então remove os antigos; falha desfaz o que criou |
| P2 | PDF aceitava qualquer https | Corrigido: só https e domínio `*.cora.com.br` (teste com domínio estranho) |
| P2 | `baseUrl` do webhook mal validada | Corrigido: `URL`, https, sem porta/caminho/credenciais, hostname válido |
| extra | Auditoria `boleto.settle_review` repetia a cada conferência | Corrigido: um registro por boleto e motivo |

Achados na validação REAL no stage (não vistos pelo Codex): (1) o aviso real traz `webhook-event-type` em MAIÚSCULAS (`invoice.CANCELED`) → normalizado para minúsculas; (2) vem um cabeçalho `signature` que a documentação da Cora não explica → não usado como prova (o aviso continua só gatilho de reconsulta; pedir à Cora o método de verificação é melhoria futura); (3) cada cancelamento gerou 2 avisos com ids diferentes → o índice de pendentes os funde; (4) o agendador precisava de `.env.credentials` para abrir as credenciais (corrigido no compose); (5) o segredo da rota aparece no log de acesso do nginx (limitação aceita: o segredo só dispara reconsultas, nunca baixa nada; girar o segredo em Integrações → Cora).
