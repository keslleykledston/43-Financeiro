# K3G Finance / instruções permanentes Claude Code

Missão: construir aplicação financeira K3G Solutions + K3G Call, com UX minimalista estilo iOS, segurança e pequenas entregas testáveis. Usuário não é programador. Não atrapalhe serviços já presentes no host.

## Carregamento de contexto (economia de tokens)
Leia no início: `START_HERE.md`, `agent/memory/NOW.md` (se existir), `agent/memory/INDEX.md`, `docs/BACKLOG.md` (somente entrega ativa). Leia `docs/PRD.md`, `docs/SEGURANCA.md` e `docs/ARQUITETURA.md` quando relevantes; NÃO despeje todo o repositório no prompt. Atualize `agent/memory/NOW.md` em cada pausa e entrega.

## Agent-loop obrigatório
DISCOVER (comandos/repo) → PLAN (uma fatia) → IMPLEMENT → TEST (unit/integration/e2e) → INDEPENDENT REVIEW (Codex quando disponível, sempre em autenticação, pagamentos, NF, permissão, migrations e deploy) → FIX → DOCUMENT (`help/` quando impactar UX) → DEPLOY SAFE → VERIFY → GIT COMMIT → MEMORY CHECKPOINT → NEXT.

## Regras obrigatórias
- A primeira entrega deve ser VISUAL e verificável no navegador. As próximas devem mostrar valor ao usuário.
- Sem dados, emails, boleto, nota fiscal, PIX ou pagamentos reais antes de autorizações próprias.
- Sem segredos no Git, logs, prints, prompts, Lovable, Codex ou documentos. Use `.env` local e secrets fora do Git.
- Toda query tem isolamento por empresa e autorização server-side; não basta esconder UI.
- Produção só com migrações compatíveis, testes, backup/restauração, rollback e observabilidade.
- Gestão de usuário, convite, RBAC e logs desde os primeiros sprints.
- Toda interface nova ganha artigo de ajuda correspondente ou atualização.
- Resumos curtos. Reporte: entregue / link testável / testes / limitações / próximo passo.

## Regras de domínio
2 CNPJs; 1 conta Cora por CNPJ; ~51-150 clientes no grupo; serviços mensais pós-pagos. Competência do serviço M e vencimento em M+1. Lotes dia 25 do mês anterior para vencimentos 1-12, exceto clientes que exigem NF com boleto: ambos dia 1 do mês do vencimento; vencimentos 13-16 emite dia 1, 17-22 dia 8, 23-30 dia 15. Regras faltantes ou de risco fiscal ficam como feature flags / aprovação humana.

## Respeito ao host
Não altere DNS, firewall, outros containers/sites, Nginx global nem recursos compartilhados sem validar impacto e backup. Nunca desative segurança para ganhar velocidade.
