# Codex — WhatsApp W3b (webhook assinado, respostas, «PARAR», entrega/leitura, caixa de entrada, triagem) — migração 0049
Data: 2026-10-29 · Revisão read-only (Codex 1.0.4). Decisões: `docs/architecture/ADR-whatsapp-001.md` (seção «Entrega 3b»). Sem CRITICAL.

| Sev. | Achado | Tratamento |
|---|---|---|
| HIGH | A rota pública lia o corpo inteiro em memória antes do limite de 256 KB | `readBodyCapped`: lê em **fluxo**, corta ao passar do limite e já recusa pelo `Content-Length`; a rota responde 413 antes de qualquer processamento; teste com fluxo sem fim. (Limites de tempo/tamanho no proxy continuam recomendados) |
| HIGH | Cada assinatura inválida escrevia em `rate_limits` (trabalho persistente no banco para quem não tem a chave) | Contador **em memória** (60 inválidas/min → 429, sem escrever no banco); teste prova zero escrita em `rate_limits` e na auditoria |
| MEDIUM | Lease de 5 s sem dono: inline + agendador podiam processar o mesmo «PARAR» e duplicar consentimento/auditoria | Lease de 60 s; o **evento é fechado primeiro** sob a **mesma trava por telefone** do registro de consentimento (só quem o encontra pendente grava consentimento/auditoria); teste com 3 processadores em paralelo |
| Info | Cifra com contexto fixo `whatsapp-inbound` (não por empresa) | Aceito: o acesso é por empresa no serviço; a triagem não tem empresa até ser atribuída |
| Info | Opt-out global registrado na primeira empresa vinculada quando a empresa é incerta | Aceito e documentado: o bloqueio vale por telefone/escopo, independente da empresa |
| Info | Os testes só olhavam `whatsapp_inbound_events` para «nada gravado» | Passam a olhar também `rate_limits` e auditoria |
Pontos verificados sem achado: HMAC/algoritmo/hex/tempo constante/janela, falha fechada, roteamento e triagem sem vazamento entre empresas, ausência de XSS (texto como conteúdo React), mídia não baixada, auditoria sem telefone/texto, `reply_pending` com caminho de resolução.
Achados do desenvolvimento (testes): precedência de `or` na SQL da reivindicação do evento; o gatilho barrava o preenchimento do telefone (agora preenche uma vez).
