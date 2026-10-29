# Codex — WhatsApp W1 (conexão por QR + envio manual de teste, WAHA não oficial) — migração 0046
Data: 2026-10-29 · Duas revisões read-only (Codex 1.0.4) do diff antes do deploy. Spike real da WAHA e decisões: `docs/architecture/ADR-whatsapp-001.md`.

## 1ª revisão (3 HIGH · 3 MEDIUM · 1 LOW) — todos tratados
| Sev. | Achado | Tratamento |
|---|---|---|
| HIGH | Compose exigia `.env.waha` e podia derrubar web/scheduler | Serviço `waha` em perfil `whatsapp` (`docker compose --profile whatsapp up -d waha`); web/scheduler/tools leem `.env.waha` como opcional; WAHA nunca sobe sem chave |
| HIGH | Envio manual não idempotente (duplo clique com vagas sobrando mandava 2) | Chave por tentativa da tela (`idempotency_key` + índice único por empresa + pré-checagem + checagem sob trava); teste com 4 requisições paralelas = 1 envio |
| HIGH | Conferência final não checava a conexão | Relê status do banco E consulta a WAHA ao vivo (exige `WORKING`) antes de enviar; teste com queda entre avaliar e enviar |
| MEDIUM | `provider_ref` podia gravar telefone | Só SHA-256 (32 hex) do id (`refHash`); teste prova que o telefone não está em log/auditoria |
| MEDIUM | Corpo da resposta fora do prazo e sem limite | `call()` lê o corpo dentro do mesmo prazo e corta por streaming (1 MB; QR 200 KB); testes de corpo gigante e corpo travado |
| MEDIUM | Reserva presa em `enviando` ocupa o limite sem saída | `settleStaleSends` (diretoria, >10 min → `desconhecido`, nunca reenvia) + aviso e botão na tela |
| LOW | Porta da WAHA não fixada | Só `:3000` |

## 2ª revisão (2 HIGH · 3 MEDIUM · 3 LOW) — sem CRITICAL
| Sev. | Achado | Tratamento |
|---|---|---|
| HIGH | Violação de unicidade (23505) na corrida de chave igual viraria 500 | Mapeada para «já registrado» (duplicata), sem erro |
| HIGH | Exceção inesperada depois da reserva deixava `enviando` pendurado | `try/catch` pós-reserva: antes do pedido = `falhou`; depois = `desconhecido`; mensagem da exceção nunca vai à auditoria; teste |
| MEDIUM | `finish()` auditava `enviado` mesmo se a reserva já tinha sido encerrada à mão | Só altera/audita quando fecha de verdade; senão registra `whatsapp.test_late_result`; teste com resultado tardio |
| MEDIUM | Hash do `provider_ref` dificulta correlação na entrega 3 | `refHash` exportado e documentado: a entrega 3 aplica o mesmo hash ao id recebido |
| MEDIUM | `getSession` nulo → mensagem «Nada foi enviado» afirma mais que a evidência | Mantido: o bloqueio ocorre ANTES de chamar `sendText`, então a afirmação é verdadeira |
| LOW | Sem `AbortSignal` do pedido do usuário durante o envio | Aceito: queda no meio cai em `settleStaleSends`; resultado nunca é reenviado |
| LOW | Testes: janela de 10 min e transições inválidas do gatilho | Teste cobre reserva recente intocada e transições válidas/inválidas do gatilho |
| LOW | `waha.test` não verifica o hash | O hash é verificado em `whatsapp.int.test` (camada que o aplica) |

## Achado do e2e (não do Codex)
`crypto.randomUUID()` quebrava a tela de teste em HTTP (não é contexto seguro) → chave gerada com `getRandomValues` no navegador, após hidratar. Também: o formulário de autorização sumia ao salvar e a confirmação se perdia → redireciona com aviso persistente.

## Limite honesto da validação
Nenhum envio real foi feito: a WAHA só foi exercitada em spike (sem login de aparelho) e por WAHA falsa que reproduz os formatos medidos. O formato real da resposta de `sendText` e o pareamento do número só serão provados no canário com aparelho (WhatsApp pode recusar parear em IP de datacenter).
