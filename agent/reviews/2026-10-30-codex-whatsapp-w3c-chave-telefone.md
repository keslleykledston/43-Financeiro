# Revisão Codex — WhatsApp W3c: chave canônica de telefone e referência de mensagem (2026-10-30)

**Origem:** teste real do dono (cobrança enviada à K3G TESTE e resposta «Ola»). No banco: o aviso de entrega/leitura foi ignorado (id `…@c.us_<HEX>` no envio × `…@lid_<HEX>` no aviso) e a resposta chegou com telefone de 12 dígitos (a WAHA omite o 9º dígito de contas antigas) contra 13 no cadastro/consentimento/fila. Comparação exata faria o «PARAR» não bloquear o cliente e a resposta não suspender a cobrança. Só K3G TESTE (fictícia) estava liberada: sem exposição real.

**Correção (sem migração):** `msgRef` (ID final da mensagem), `phoneKey`/`phoneKeySql` (mesma regra de `sameBrNumber`) em `domain.ts`; usados em consentimento, supressão da fila, flood, `hasOpenReply`, atribuição, locks advisory e `listConsents`. Testes: `tests/whatsapp-keys.test.ts` + 2 casos em `tests/whatsapp-w3b.int.test.ts`. SANDBOX PASS 748 + 134.

**Codex (somente leitura):** nenhum achado (CRITICAL/HIGH/MEDIUM/LOW) em: comparações restantes, regex/SQL, forja de ack, locks, dados antigos. Observação honesta: o Codex não executou testes.

**Limite conhecido:** envios/confirmações anteriores à correção (1 teste + 1 cobrança de K3G TESTE) ficam sem entrega/leitura gravada (o hash antigo não é reversível).
