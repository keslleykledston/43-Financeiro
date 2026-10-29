# Revisão Codex (somente leitura) — E10b-6 emissão de boletos REAIS na Cora de produção (2026-10-28)
Escopo: cliente HTTP (trava dupla), registro de provedores, adaptador (anti-duplicidade), `issuance/{service,sync,webhooks,cancel,cancel-request}`, telas, migração 0044, compose, testes.
Veredito inicial: **BLOQUEIA** (2 P1). Após as correções: sem P0/P1 abertos. Nenhum caminho de pagamento/transferência/saldo/extrato (confirmado).

| Sev. | Achado | Tratamento |
|---|---|---|
| P1 | Cadastro de webhook de PRODUÇÃO não exigia empresa armada nem autorização registrada | Corrigido: exige a chave do servidor E `issuance_settings` em `cora_producao` com `live_authorized_at` (teste novo) |
| P1 | Cancelar boleto REAL não conferia autorização/armamento nem confirmação própria | Corrigido: política explícita (ADR-036): diretoria + chave ligada + confirmação ESPECÍFICA `confirmLive` conferida no servidor (inclusive na aprovação de pedido de cancelamento); continua possível depois de a empresa voltar ao simulado (o boleto existe lá fora e só pode ter sido emitido com a empresa armada). Checkbox próprio na tela, só para boleto de produção |
| P2 | Anti-duplicidade e POST são duas chamadas: emissão manual simultânea não é detectada | Aceito e documentado (docs/E10_GOLIVE.md, "Limites conhecidos"): sem emissão manual da empresa durante a rodada do canário |
| nota | A Cora não documenta o padrão sem `notification` | Documentado: não enviamos `notification` nem e-mail do cliente; confirmar com a Cora antes de liberar volume |
| nota | Faixa vermelha some com a chave do servidor desligada | Aceito: com a chave desligada nenhum boleto real é emitido |
