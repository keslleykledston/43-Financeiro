# Codex — área de clientes: nome aparente, Editar, emite boleto/NF (2026-11-04)
Escopo: migração 0053 (alias, issues_boleto, issues_invoice, display_name recriada, public_name), `crm/extras.ts`, trava de emissão (`issuance/service.ts`), mensagens (`public_name`), UI de clientes e lote.
Resultado: 0 CRITICAL, 0 HIGH, 1 MEDIUM.
- MEDIUM: o preview da régua de WhatsApp (`whatsapp/regua.ts:70`) usa `display_name` (que agora prioriza o alias). É uma tela INTERNA da equipe, então mostrar o nome aparente ali é o comportamento desejado; o envio real usa `public_name`. Aceito, sem mudança.
- Observação: `retryDuplicate` pode criar solicitação substituta sem checar `issues_boleto`; a guarda do worker (`cliente_sem_boleto`) impede qualquer emissão. Aceito.
Verificado: ordem da migração, reversão documentada, permissões/isolamento, auditoria sem valores, sem XSS, NFS-e não afetada, e-mail/WhatsApp ao cliente sem o alias.
