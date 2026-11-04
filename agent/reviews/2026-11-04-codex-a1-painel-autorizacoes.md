# Codex — A1 painel único de autorizações (2026-11-04)

Escopo: `src/modules/authorizations/panel.ts`, página `/autorizacoes`, marca «todos» (`*`) no e-mail real (smtp/email-auth/email-live/messaging), chaves liga/desliga.

## 1ª rodada
- **HIGH 1** — «Salvar limite» recriava a autorização com `*` (ampliava lista antiga; chamada direta ligava a função desligada) → CORRIGIDO: `setEmailLimit`/`setWhatsappLimit`/`setReguaKinds` exigem a função já ligada e preservam lista e referência; «ligar» com a função já ligada só ajusta o limite.
- **HIGH 2** — `*` em `isAllowed` valia para e-mails do sistema (senha/convite) → CORRIGIDO: `isAllowed` voltou a ser estrito; `isAllowedOutbound` (aceita `*`) só no adaptador de envio; na fila, com `*` os destinatários são só os contatos financeiros DO cliente da cobrança; teste/«Testar conexão» continuam só para o próprio e-mail.
- **MEDIUM 1** — tela mostrava «Ligado» com a chave do servidor desligada → CORRIGIDO: `serverOff` + aviso «Ligado aqui, mas PARADO pelo servidor».
- **MEDIUM 2** — nome do usuário na referência da autorização → CORRIGIDO: referência fixa com a data (quem ligou fica em `authorized_by`/auditoria).
- Sem achados: permissões por função e isolamento por empresa; boletos passam por `saveIssuanceSettings` (chave do servidor, credencial autentica, sem boletos em andamento, entra em canário); consentimento/opt-out do WhatsApp; confirmação do navegador é só conveniência.

## 2ª rodada
Os 4 achados fechados; nenhum CRITICAL/HIGH/MEDIUM/LOW novo.
