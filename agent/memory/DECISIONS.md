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
