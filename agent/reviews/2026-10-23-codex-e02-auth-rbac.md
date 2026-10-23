# Revisão Codex — E02 auth/RBAC (commit b850004), 2026-10-23
Escopo: auth, middleware, contexto de empresa, serviço de identidade, convites, migrations. Somente leitura; testes não executados pelo revisor.

| # | Prio | Achado | Status |
|---|------|--------|--------|
| 1 | P1 | Conta desabilitada mantém acesso até o JWT (8h) expirar | CORRIGIDO: `requireContext` revalida `disabled_at` a cada requisição; `/sair` encerra a sessão. Teste `isUserActive`. |
| 2 | P1 | Convite não prova posse do e-mail; conta existente ganhava vínculo só com o link | PARCIAL: e-mail digitado deve bater; conta existente exige senha atual; limite de tentativas por link/IP. **Residual:** posse de e-mail de conta NOVA só será verificada com envio de e-mail (ADR-003). |
| 3 | P1 | Rate limit em memória e só por e-mail | CORRIGIDO: tabela `rate_limits` (atômico, compartilhado), chaves conta+IP (5), conta (20), IP (30). Teste de não-DoS por IP. |
| 4 | P2 | HSTS/CSP ausentes | ABERTO (decisão consciente; avaliar subdomínios). |
Refutados: cookie de empresa (bypass), CSRF das server actions, enumeração/timing no login. Sem RLS no schema: isolamento depende da aplicação (aceito; reavaliar com dados reais).
Evidência: 9 testes passam no container (8 integração em DB de teste).
