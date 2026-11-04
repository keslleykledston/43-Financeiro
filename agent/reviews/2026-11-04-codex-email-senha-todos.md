# Codex — e-mail de senha com a marca «todos» (2026-11-04)
Escopo: `email-system.ts` (`mailReadiness` com `ownAddress`, `mailRouteForUser`, `sendSystemEmail`), testes de recuperação e e-mail.
Resultado: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 1 LOW.
- LOW: o motivo auditado de `mailRouteForUser` depende da ordem das empresas (não muda o envio). Aceito.
- Tempo: a tela responde antes do trabalho (`after()`), então a diferença de tempo entre conta existente e inexistente não aparece ao usuário. Aceito.
Veredito: 'senha' só vai ao e-mail de login de usuário cadastrado e ativo; convite segue estrito.
