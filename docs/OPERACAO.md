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

## Rollback de migrações (Drizzle não gera "down")
Regra: antes de `pnpm db:migrate` em produção, `scripts/backup.sh`. A reversão é **restaurar o backup** (`docs/DEPLOY.md`, `scripts/restore-test.sh` valida o formato) ou aplicar o SQL inverso abaixo se nada foi gravado nas estruturas novas. Primeiro subir de volta a imagem anterior do `web` (compatível com o esquema antigo), depois reverter o banco.

| Migração | O que faz | Reversão manual (só se as tabelas/colunas novas estiverem vazias ou descartáveis) |
|---|---|---|
| 0010 | cria `contracts`, `contract_versions`, `holidays` | `DROP TABLE contract_versions; DROP TABLE contracts; DROP TABLE holidays;` (nessa ordem; perde contratos/feriados cadastrados) |
| 0011 | CHECK de valor máximo em `contracts`; estado `substituida` em `contract_versions` | `ALTER TABLE contracts DROP CONSTRAINT contracts_amount_chk; ALTER TABLE contracts ADD CONSTRAINT contracts_amount_chk CHECK (monthly_amount > 0);` e, se não houver versão `substituida`, recriar `contract_versions_state_chk` com 3 estados. Com versões `substituida` existentes, restaurar o backup. |
| 0012 | cria `billing_batches` e `charges` (E05) | `DROP TABLE charges; DROP TABLE billing_batches;` (nessa ordem; perde lotes/cobranças — só antes de qualquer emissão real; depois, restaurar backup) |

Cada nova migração deve acrescentar sua linha nesta tabela no mesmo commit.
