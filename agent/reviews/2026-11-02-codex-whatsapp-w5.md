# Codex — WhatsApp W5 (remover conexão + simulação por dia) — 2026-11-02

Revisão read-only em 4 rodadas (Codex nunca editou; Claude corrigiu).

| Rodada | Achado | Tratamento |
|---|---|---|
| 1 | HIGH: corrida remoção × enfileirar/enviar/vincular (checagens fora das travas) | Checagens + pausa sob travas `send`/`bind`/`queue`; `sessionUsable` recheca sob as travas de enfileirar e de reservar envio; `bindCompany` recusa `REVOKED` |
| 1 | MEDIUM: remoção "concluída" sem apagar na WAHA (módulo desligado) | Exige módulo+WAHA configurados; senão recusa |
| 2 | HIGH: queda entre commit REVOKED e `deleteSession` deixava sessão órfã na WAHA | Duas fases: pausa → apaga na WAHA → só então `REVOKED`; queda = pausada e visível, repetir é idempotente (404 = apagada) |
| 2 | (a) simulação `asOf`: sem regressão no envio real; (b) permissão/isolamento/vazamento: sem falha | — |
| 3 | HIGH: `bindCompany` aceitava vínculo entre as fases | Fase 2 numa transação que segura `whatsapp-bind:<sessão>` durante a chamada à WAHA; recontagem de vínculos antes de apagar |
| 4 | HIGH: `startSession` corria contra a remoção (podia recriar a sessão na WAHA) | `startSession` pega a mesma trava de vínculo e recusa `REVOKED`; `syncFromWaha` não ressuscita `REVOKED` (guarda no UPDATE). **Sem nova rodada do Codex após esta correção** (testes cobrem: iniciar após remover é recusado e não recria na WAHA) |
| 4 | MEDIUM: chamada de rede (≤15 s) dentro de transação segurando 1 conexão do pool (5) | **Aceito**: operação rara e manual; estado durável exigiria migração. Documentado no ADR |
| 3 | MEDIUM: sem «cancelar remoção» | Aceito: reconectar (Iniciar → Conectada) e «Liberar envios» retomam |

Sem CRITICAL. Deadlock: nenhum ciclo (remoção send→bind→queue; fila: queue; reserva: send→send-co; vínculo: bind).
