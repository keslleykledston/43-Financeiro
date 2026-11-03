# Codex (somente leitura) — «Testar conexão» do SMTP + formulário que voltava vazio (2026-11-03)
Escopo: `smtp.ts` (prepare/verifySmtpConnection), `email-live.ts` (testEmailAccount), Integrações (actions, email-form, email-live-forms, page), testes e e2e.
Regra decidida pelo dono: o teste não exige autorização; sem autorização o e-mail de teste só vai ao e-mail de login de quem testa (teto 5/dia, texto fixo); a verificação de login nunca envia e-mail; chave do servidor desligada = só a verificação.

- CRITICAL/HIGH: nenhum.
- MEDIUM (aceito, documentado): revogar a autorização entre a checagem e a conexão SMTP ainda deixa sair UM e-mail de teste (janela de milissegundos; mesmo desenho do teste do canário já aceito). O envio é a um endereço da lista/ao próprio login, texto fixo.
- LOW (aceito): o teto de 5 testes/dia usa `sentToday`, que também conta a fila; envios da fila podem consumir o teto (conservador, nunca excede).
- Sem achados: bypass de travas, vazamento de segredo/texto do servidor, SSRF/DNS/timeouts, isolamento por empresa/permissão, formulário.
