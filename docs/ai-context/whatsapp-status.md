# WhatsApp (WAHA) — status para continuidade entre modelos
Sem segredos, QR ou telefones. Atualizado: 2026-10-30.

- **Pacote de specs:** `Financeiro_WG_WhatsApp_WAHA_Implementacao_v1` (docs/prompts em 4 entregas). Projeto real = K3G Finance (`43-Financeiro`). ADR: `docs/architecture/ADR-whatsapp-001.md`.
- **Entrega 1 (conexão + QR + teste manual): implementada e VALIDADA com aparelho real (mensagem entregue em 2026-10-29)** — módulo `src/modules/whatsapp/*`, adaptador `src/modules/providers/waha.ts` (único que fala com a WAHA), telas `/whatsapp` e `/whatsapp/teste`, rota `GET /api/v1/whatsapp/sessions/[id]/state`, migração 0046, ajuda `help/whatsapp-conexao.md`.
- **Chaves:** `WHATSAPP_MODULE_ENABLED=true` (só gerencia), `WHATSAPP_SEND_ENABLED=true` (ligada por ordem do dono em 2026-10-29; só envio manual de teste autorizado), `WHATSAPP_AUTOMATION_ENABLED=false`, antiga `WHATSAPP_LIVE_ENABLED=false` (NÃO ligar: recusa toda emissão real).
- **WAHA:** `devlikeapro/waha:gows-2026.8.2` por digest, serviço `waha` no compose, sem porta publicada, chave em `.env.waha` (não ler).
- **Regras que não mudam:** sem evasão de bloqueio, sem massa/grupos/mídia; opt-out prevalece; resultado ambíguo = `desconhecido` sem retry; empresa nunca vê dados de outra; texto/telefone completo fora de log.
- **Entrega 2 (vínculo entre empresas + consentimento/opt-out + bloqueios): implementada** — `bindCompany`/`unbindCompany`, `whatsapp_consents` (0047), `/whatsapp/consentimentos`. Opt-out global prevalece; envio a cliente (entregas 3/4) exigirá opt-in da empresa.
- **Próximo (antigo):** entrega 2 (vínculo de 2ª empresa com diretoria das duas, consentimento/opt-out por contato, UI de bloqueios). Antes: validar com o dono o pareamento real do número e o envio de teste.
- **Gate por entrega:** `pnpm sandbox` PASS → Codex read-only → backup → migração → deploy → smoke → docs (NOW, BACKLOG, OPERACAO, DECISIONS, review) → commit + push (sem tag/force).

- **Lição do 1º envio real:** o motor GOWS só envia após resolver o número (`/api/contacts/check-exists`); contas antigas existem sem o 9º dígito — aceitar só a equivalência oficial e só para o número autorizado (`sameBrNumber`). Erro 500 da WAHA continua tratado como «desconhecido» (nunca reenviar sozinho).

- **Próximo real:** entrega 3 (modelos/aprovação, fila/outbox, receptor de webhook HMAC sha512 — hash do id: `refHash`, caixa de entrada/triagem; opt-out por resposta «PARAR»).
- **Entrega 4 (régua automática + painel): implementada, DESLIGADA** — `src/modules/whatsapp/regua.ts`, `/whatsapp/regua`, migração 0050. Três chaves: servidor `WHATSAPP_AUTOMATION_ENABLED` (false), empresa (diretoria + frase `LIGAR RÉGUA DE WHATSAPP` + referência) e cada régua (D-3/D0/D+3/D+7). Mesmas travas do envio manual; só no dia exato; só a partir do dia seguinte ao de ligar; 1 tentativa por cobrança+marco; roda em nome de quem ligou e para se perder a permissão. NÃO ligar em produção sem aprovação operacional do dono.
