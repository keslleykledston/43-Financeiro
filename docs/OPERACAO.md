# Operação e manutenção

## Runbook mínimo
- `/health/live` simples sem conexão DB; `/health/ready` interno com DB e worker checks, sem revelar credenciais ou configs.
- Monitorar status/versão app, espaço livre, backups, filas pendentes, erros de integrações, tempo desde última conciliação, falhas de envio.
- Alerta sem expor dados pessoais: “falhas de emissão > N”, “backup atrasado”, “jobs travados”, “DB indisponível”, “documento fiscal pendente”.
- Logs com requestId/traceId, tenant masked ou uuid, status, duração, sem tokens, CPF/CNPJ completos, payload bancário, e-mail completo, anexos ou senhas.
- Manter CHANGELOG, migrações, owner do deploy, recovery point/recovery time desejados a serem definidos.

## Rotinas
- Diária: ver jobs pendentes/falhados e saúde da última conciliação, executar backup automatizado.
- Semanal: confirmar sucesso de backup/teste automatizado; revisar atualização de dependências e avisos de segurança.
- Mensal: fazer restore teste em ambiente isolado, revisar permissões, fechamento gerencial e diffs de dinheiro.

## Procedimento incidente
1. Suspender ação externa com flags (não desligar a interface sem necessidade).
2. Isolar falha com requestId e estado dos jobs.
3. Preservar logs e auditoria; nunca limpar registros de movimento financeiro.
4. Restaurar serviço de forma reprodutível; aplicar correção revisada.
5. Registrar postmortem/ADR para evitar recorrência.
