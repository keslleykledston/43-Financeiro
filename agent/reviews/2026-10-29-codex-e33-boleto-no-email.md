# Revisão Codex (somente leitura) — E33 boleto no e-mail (2026-10-29)
Escopo: `messaging/boleto-mail.ts` (novo), `messaging/service.ts` (prefetch, fila simulada e e-mail real), `providers/{smtp,types}.ts` (anexo PDF), modelos padrão, `issuance/boleto-details.ts` (`safePdfUrl`), testes.
Veredito inicial: **BLOQUEIA** (1 HIGH). Após as correções: sem P0/P1 abertos. Sem CRITICAL. Nenhum e-mail real foi enviado (chave desligada).

| Sev. | Achado | Tratamento |
|---|---|---|
| HIGH | E-mail real podia sair SEM o PDF quando a Cora respondia sem URL ou com URL de origem não permitida (o boleto virava `ok`) | Corrigido: o boleto só é `ok` com linha digitável E PDF de origem permitida; senão `indisponivel` (a mensagem espera). Testes: URL de outro domínio e URL vazia |
| MEDIUM | Boleto podia mudar (pago/cancelado/alterado) entre a consulta da rodada e o envio | Corrigido: reconsulta IMEDIATAMENTE antes do SMTP; mudou → volta à fila sem enviar (`boleto_mudou`). Teste com cancelamento após reservar |
| lacuna | Valor/vencimento do boleto remoto não eram comparados com os da cobrança | Corrigido: só é o boleto da cobrança se valor e vencimento batem (teste com valor alterado na Cora) |
| MEDIUM | Sem boleto ativo, o item fica pendente sem resolução explícita | Aceito: a mensagem espera ("Aguardando o boleto emitido") e, passado `maxLateDays`, vira "Perdeu a data" com motivo para revisão manual; boleto pago/cancelado para a régua (já existente) |
| nota | Linha digitável fica em `message_queue.rendered_body` | Aceito: é o mesmo conteúdo enviado ao cliente (registro do que foi enviado); tabela já escopada por empresa e permissão de mensagens |
| nota | Sem checagem de IP no download do PDF | Aceito: origens fixas da Cora, https, sem redirecionamento; endurecimento possível no futuro |
