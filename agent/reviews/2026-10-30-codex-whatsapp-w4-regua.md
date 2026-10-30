# Revisão Codex — WhatsApp W4: régua automática e painel (2026-10-30)

**Escopo:** `src/modules/whatsapp/regua.ts` (ligar/desligar, simulação, agendador, painel), `outbound.ts` (origem da mensagem), `service.ts` (`automationOn`), `scripts/scheduler.ts`, migração 0050, telas `/whatsapp/regua`.

**Achados (Codex, somente leitura; não executou testes):**
- **HIGH — tratado:** mensagem de origem `regua` podia sair pelo botão «Enviar» do histórico com a régua/chave desligada, e uma corrida ao desligar. Agora o despacho confere chave do servidor + empresa + marco (e suprime com `regua_desligada`) e repete a conferência no último instante antes de entregar. Teste: «mensagem de origem régua NÃO sai pelo botão…».
- **MEDIUM — tratado:** ritmo de 2 envios/ciclo só em memória → agora contado no banco (último minuto), compartilhado entre instâncias.
- **MEDIUM — tratado:** painel somava o mesmo pagamento por mensagem → agora agrega por cobrança.
- **MEDIUM — aceito e documentado (ADR, ajuda):** pagamento que chega durante a chamada já iniciada à WAHA não desfaz o envio (janela de segundos; a dívida é relida antes e depois da consulta do número).
- **LOW — aceito:** busca de candidatos a cada minuto só nas empresas com a régua ligada e conexão conectada.
- Sem achados em: SQL injection/`sql.raw`, isolamento entre empresas, actor/permissões, PII no painel, logs.
- Observação do Codex: CHECK não exige `automation_authorized_at`; sem ele a régua não roda (falha segura).

**Qualidade:** SANDBOX PASS 758 unitários/integração + 135 e2e. Durante a rodada: seletor ambíguo e dependência de ordem no e2e novo (corrigidos); asserção frágil de «sem telefone na auditoria» em 4 testes WhatsApp (procurava `5592` no JSON inteiro, que traz UUIDs aleatórios; agora só `action`/`detail`).

**Deploy 2026-10-30:** backup `k3gfinance-20261030T133446Z`, migração 0050 (51 no total), web/scheduler recriados. **Régua DESLIGADA em todas as empresas** e chave `WHATSAPP_AUTOMATION_ENABLED: "false"`. Smoke: health 200, `/whatsapp/regua` 307 sem login, webhook sem assinatura 401, nenhuma mensagem `origin='regua'`.
