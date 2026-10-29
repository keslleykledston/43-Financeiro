# WhatsApp (WAHA) — status para continuidade entre modelos
Sem segredos, QR ou telefones. Atualizado: 2026-10-29.

- **Pacote de specs:** `Financeiro_WG_WhatsApp_WAHA_Implementacao_v1` (docs/prompts em 4 entregas). Projeto real = K3G Finance (`43-Financeiro`). ADR: `docs/architecture/ADR-whatsapp-001.md`.
- **Entrega 1 (conexão + QR + teste manual): implementada** — módulo `src/modules/whatsapp/*`, adaptador `src/modules/providers/waha.ts` (único que fala com a WAHA), telas `/whatsapp` e `/whatsapp/teste`, rota `GET /api/v1/whatsapp/sessions/[id]/state`, migração 0046, ajuda `help/whatsapp-conexao.md`.
- **Chaves:** `WHATSAPP_MODULE_ENABLED=true` (só gerencia), `WHATSAPP_SEND_ENABLED=false` (liga só por ordem do dono), `WHATSAPP_AUTOMATION_ENABLED=false`, antiga `WHATSAPP_LIVE_ENABLED=false` (NÃO ligar: recusa toda emissão real).
- **WAHA:** `devlikeapro/waha:gows-2026.8.2` por digest, serviço `waha` no compose, sem porta publicada, chave em `.env.waha` (não ler).
- **Regras que não mudam:** sem evasão de bloqueio, sem massa/grupos/mídia; opt-out prevalece; resultado ambíguo = `desconhecido` sem retry; empresa nunca vê dados de outra; texto/telefone completo fora de log.
- **Próximo:** entrega 2 (vínculo de 2ª empresa com diretoria das duas, consentimento/opt-out por contato, UI de bloqueios). Antes: validar com o dono o pareamento real do número e o envio de teste.
- **Gate por entrega:** `pnpm sandbox` PASS → Codex read-only → backup → migração → deploy → smoke → docs (NOW, BACKLOG, OPERACAO, DECISIONS, review) → commit + push (sem tag/force).
