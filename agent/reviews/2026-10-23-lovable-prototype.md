# Revisão do protótipo Lovable (e352b98c…) — 2026-10-23
Commit Lovable: ad8ab25e. Custo: **18,2 créditos**. Revisão minha (leitura via MCP); o código ainda NÃO foi portado.

## Conforme o briefing
- **Sem backend**: não há Supabase, `.env`, fetch/API nem segredos; dados em `src/mocks/`. `@tanstack/react-query` está nas deps mas sem uso evidente (descartar no porte).
- **Componentes puros** em `src/components/k3g/` (primitives, shell, dashboard, parties, csv-import, access, states, login). **Único acoplamento ao roteador:** `AppLink` (trocar por `next/link`).
- **Tokens** oklch em `src/styles.css`, **claro padrão + escuro** (`.dark`), acento teal com **AA no claro** (`oklch(0.48 0.095 190)` ≈ 5,6:1 sobre branco), semânticas `positive/negative/warning/info` com `*-soft` e `*-foreground`, `demo`, `brand-panel`, gráficos `--chart-1..5`, raio 12px, `:focus-visible`, `prefers-reduced-motion`, utilitário `.num` (tabular).
- **Dinheiro em centavos** (`format.ts`: `formatBRL`, `formatPct`, `maskDocument` com CNPJ alfanumérico) + testes. Selos sempre com ícone + texto (`SeverityBadge`, `StatusPill`, `Delta`), `OneTimeSecret`, `SoonTag`.
- Telas: login (só convite), dashboard (KPIs, drill-down, gráfico, alertas, lotes), clientes (lista/novo/detalhe/importar), ajustes (usuários, convite, matriz), sem-acesso, desatualizada, `/design-system`.

## Limitações declaradas pelo próprio Lovable
Toggle de tema, envio de formulários e fluxo de importação **não testados no navegador**; "Novo contrato" e "Simular lote" desabilitados; Editar/Exportar/Esqueci a senha sem ação.

## Diferenças a resolver no porte
| Tema | Protótipo | Nosso app | Ação |
|---|---|---|---|
| Tailwind | v4 (`@theme inline`, `@utility`) | v3 | migrar para v4 (`@tailwindcss/postcss`) |
| Fontes | Space Grotesk + IBM Plex Sans | system | self-host via `@fontsource` (sem CDN, compatível com CSP) |
| Roteamento | TanStack Router | Next App Router | `AppLink` → `next/link`; rotas viram páginas |
| Tipo de cadastro | `PartyType` inclui "ambos" | tabelas separadas customers/vendors | não portar "ambos" (ADR-007) |
| Telas novas nossas | — | Integrações/CRM, selo CRM, somente leitura | desenhar no mesmo sistema (reusar primitives) |
| Estados | demonstração local | server actions | ligar a dados reais, manter componentes puros |

## Plano de porte (próxima fase, após fechar a integração CRM)
1. Tailwind 4 + tokens + fontes self-hosted; 2. primitives/format/AppLink; 3. shell (sidebar/bottom nav/tema/empresa); 4. migrar telas existentes uma a uma mantendo os e2e verdes; 5. página `/design-system`; 6. e2e de tema claro/escuro e 375px.
