# Revisão Codex — E23 (adaptador de e-mail REAL, canário, desligado), 2026-10-24

Somente leitura. Confirmou: três travas, reserva/CAS sem duplicidade, desconhecido nunca reenvia, limite diário com lock, lista conferida duas vezes, SSRF/TLS/cabeçalhos, segredos fora de log/audit/tela, migração 0027 e caminho simulado preservado.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P1 | Revogar a autorização não interrompia um envio já reservado (checagem antes, envio depois, fora de transação). | CORRIGIDO: revogar/substituir usa o mesmo lock da reserva; antes de entregar CADA mensagem ao SMTP o sistema reconfere chave + autorização ativa; revogada → item volta à fila, registro "autorizacao_revogada", nada enviado. Mesmo no e-mail de teste. Teste com gancho entre reservar e enviar. Janela residual: só o que já foi entregue ao SMTP. |
| 2 | P1 | O agendador podia enviar e-mail real sozinho (o scheduler tem os segredos comuns). | CORRIGIDO: `runScheduled` nunca usa o caminho real; com o real liberado, bloqueia e deixa os e-mails na fila (só o botão "Processar fila" envia). Teste. |
| 3 | P2 | A espera do DNS não entrava no tempo limite. | CORRIGIDO: DNS com prazo de 10 s (falha "dns_falhou", repetível). Teste. |
