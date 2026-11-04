# Codex — chave própria «E-mail do sistema» (2026-11-04)
Escopo: migração 0052, `email-live.ts` (systemEmailOn/For), `email-system.ts`, `panel.ts` (setSistema), painel, `configuracao/actions.ts`.
Resultado: 0 CRITICAL, 0 HIGH, 1 MEDIUM.
- MEDIUM (corrigido): convite com chave ligada poderia servir de relay (destinatário digitado). Agora: 15 convites por e-mail/hora por quem convida e 3/dia por destinatário, mais o teto de 40/dia por empresa; recusa vai para a auditoria (`email.system_failed`, `limite_de_convites`).
- Pendência baixa: sem teste automatizado do limite de convites (server action) e do roteamento entre várias empresas.
Itens 1, 2, 5 OK (um destinatário exato, sem anexos, permissão `providers.credentials`, migração aditiva, guard de credenciais intacto).
