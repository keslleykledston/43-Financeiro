# Revisão Codex — E15 (revogação de sessões + registro de atividades)

Data: 2026-10-24 · Escopo: migração 0021 (`users.session_version`), `auth.ts`, `requireContext`, `changePassword`/`revokeSessions`, `/conta`, `/auditoria`, `src/modules/identity/audit.ts`.

Resultado: 0 P0, 0 P1, **1 P2**.
- P2 `audit.ts`: o resumo do detalhe mostrava valores escalares de quase qualquer campo (ex.: e-mail convidado em `member.invited`). **Corrigido:** chaves com cara de segredo ou dado pessoal (senha, token, chave, e-mail, telefone, CPF/CNPJ, documento, nome) saem mascaradas (`••••`); teste cobre.

Verificado sem achado: bypass de autenticação/autorização, token antigo sem `sv` (vale 0 até a 1ª revogação), usos de `auth()` fora de `requireContext` (nenhum), isolamento entre empresas na auditoria, escape de LIKE, XSS, offset/paginação (limite 200 páginas), incremento atômico da versão.

Também corrigido no caminho: teste antigo instável em `receivables.int.test.ts` (regex `/30/` contra UUIDs aleatórios).
Sandbox final: PASS 296 unit/int + 80 e2e.
