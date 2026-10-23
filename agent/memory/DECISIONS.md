# Decisões e premissas aprovadas

D001 — Construir plataforma própria, com código e banco sob controle K3G.
D002 — Dois CNPJs K3G Solutions e K3G Call; uma conta Cora por empresa.
D003 — Priorizar monólito modular + PostgreSQL self-host + Next.js UI web; substitui stack preliminar Supabase/WeWeb/n8n como padrão, por simplicidade no host do usuário. Ajustável por ADR fundamentado.
D004 — 51–150 clientes ativos combinados.
D005 — Competência M (serviço prestado), vencimento M+1 (pós-pago).
D006 — Emissão por vencimento: D=1–12 sem NF conjunta → dia 25 mês anterior; D=1–12 com NF conjunta → boleto+NF dia 1 mês do vencimento; D=13–16 → dia 1; D=17–22 → dia 8; D=23–30 → dia 15.
D007 — Envio de e-mail com boleto, NF, lembretes e cobrança; editor de templates por empresa e variáveis; reguas configuráveis.
D008 — Contas a pagar aprovadas pelo financeiro; execução de pagamentos exclusiva da diretora no banco no processo atual.
D009 — Pequenas entregas com interface funcional desde o início, deploy via Nginx host `financeiro.devops.k3gsolutions.com.br` após verificação de DNS/HTTPS.
D010 — Claude Code lidera implementação; Codex faz revisão independente quando disponível; Lovable MCP apoia UX (não obriga cloud); memória portátil no repositório.
D011 — Operações financeiras reais e comunicações externas permanecem DESABILITADAS por padrão até homologação/autorização.

Pendências: dia 31, meses curtos, feriados, alçadas, regras fiscais, API e-NF, provedores e-mail, Cora habilitação, dados reais, escopo de rateio, retenção LGPD.

## ADR-001 Stack base (2026-10-22)
Next.js 15 + React 19 + TypeScript 5.9 (TS 7 incompatível com Next 15), Drizzle ORM + postgres.js, Auth.js (next-auth v5 beta) + argon2, Zod, Tailwind 3, Vitest + Playwright, pnpm. Porta web 3150. Reversível; auth ainda não implementada.

## ADR-002 Tudo em Docker (2026-10-22, pedido do usuário)
Isolamento: db (sem ports), web (127.0.0.1:3150), tools (profile, migrate/seed/test). pnpm fixado 10.29.3 (corepack latest viola política de release age). Sem Node/DB rodando direto no host.

## ADR-003 Convites sem verificação de e-mail (2026-10-23)
Sem provedor de e-mail real (EMAIL_EXTERNAL_ENABLED=false), a posse do e-mail de um usuário NOVO não é verificada: o link (256 bits, 72h, uso único, hash no DB) enviado fora de banda pelo convidante é a prova. Mitigações: e-mail digitado deve bater; conta existente exige senha atual; rate limit. Reavaliar quando houver e-mail real (E06/E09): exigir verificação antes de ativar. Aceito para fase DEMO/sem dados reais; **bloqueia entrada de dados financeiros reais?** Não, mas convidar só pessoas conhecidas e enviar o link por canal confiável.

## ADR-004 Clientes e fornecedores em tabela única (2026-10-23)
`parties` com `kind` (cliente|fornecedor) + `party_contacts`, sempre com `company_id`. Documento normalizado (CPF 11 dígitos; CNPJ 14 posições, **aceita alfanumérico** — regra RFB: valor = ASCII−48). Unicidade parcial `(company_id, kind, document)` apenas para não arquivados (arquivar libera; restaurar pode conflitar → erro claro). Exclusão sempre lógica. Paginação por página/offset (UI); cursor fica para a API v1 (E09). Histórico lido de `audit_log.detail->>'partyId'`.
Papéis: admin_tecnico sem acesso a CRM (dado financeiro); contabilidade lê+exporta; assistente lê+grava; diretoria/gerente tudo.

## ADR-005 Versionamento: commit + push ao fim de cada fase (2026-10-23, ordem do usuário)
Remoto: `ssh://git@ssh.github.com:443/keslleykledston/43-Financeiro.git` (porta 22 redirecionada por config local; chave `~/.ssh/id_ed25519_github` via `core.sshCommand` só neste repo). Push de `main` autorizado ao fim de cada fase/entrega, após SANDBOX PASS. **Continuam proibidos sem ordem explícita:** `git tag`, push --force, reescrever histórico. Rollback = `git revert`/checkout de commit anterior + restore de backup do DB quando houver migração.

## ADR-006 Lovable desenha, Claude Code porta (2026-10-23, decisão do usuário)
Papel: Lovable = agente de UI/UX em projeto de PROTÓTIPO separado (só dados fictícios, sem backend/Supabase/auth/env). Claude Code revisa o diff, porta para Next.js (server components/actions), liga ao backend real e roda `pnpm sandbox`. Segurança, isolamento por empresa e cálculo ficam no nosso código. Nada de segredo/dados reais/ai-memory enviado ao Lovable. Cada mensagem gasta créditos: agrupar telas em lotes.
Visual: tema **claro padrão + escuro opcional**; acento teal (tokens do Ledger Lens), Space Grotesk + IBM Plex Sans, `.num` tabular; raio 12px; mobile em cards.
Projeto Lovable de protótipo: id e352b98c-1cf4-4af5-a90a-f957ea39a0f9 (workspace do dono). Referência analisada: Ledger Lens Gre (39d6711e-…) — ver docs/DESIGN_REFERENCIA_LEDGER_LENS.md.
