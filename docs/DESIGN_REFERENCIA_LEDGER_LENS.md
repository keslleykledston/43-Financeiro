# Referência de design — Ledger Lens GRE (Lovable)

Projeto analisado (somente leitura, 2026-10-23): "Ledger Lens Gre", workspace Lovable do dono, publicado. Não foi aberto o `.env` do projeto. Nada foi enviado ao Lovable.

## O que é
Módulo **financeiro gerencial** (GRE = Gerencial de Resultado Empresarial): Dashboard, Movimentações, GRE com drill-down, Fluxo de Caixa. Stack do Lovable: Vite + TanStack Start/Router + Tailwind v4 + shadcn/ui + Recharts + Supabase. Ou seja, **diferente do nosso**: Next.js 15 + Tailwind 3 + Postgres próprio + server actions.

## O que vale adotar (design)
1. **Tokens semânticos** em oklch: `--positivo`, `--negativo`, `--alerta` além do shadcn padrão. Cor sempre com ícone/texto (nunca só cor).
2. **Um acento único**: teal `oklch(0.78 0.135 178)` (batendo com "azul petróleo/ciano" do nosso `UX_UI.md`). Gráficos: 5 cores `--chart-1..5`.
3. **Tipografia**: Space Grotesk (títulos/números) + IBM Plex Sans (texto); classe `.num` com `tabular-nums` em todo valor monetário. Fontes abertas (compatível com nossa regra de não empacotar fonte proprietária).
4. **Componentes de negócio pequenos e reutilizáveis**: `CabecalhoPagina`, `Cartao`, `Kpi` (rótulo em caixa alta + valor + detalhe + variação), `Variacao` (seta + % + "vs. período anterior", com `invertido` para custos), `Valor` (colorir por sinal), `Vazio` (borda tracejada), `Esqueleto`.
5. **Drill-down até a origem**: toda linha de número abre o diálogo com os lançamentos que o compõem. Casa com nossa exigência "números rastreáveis" (E12).
6. **Barra de filtros global** (empresa, período, regime competência/caixa) no topo de cada tela.
7. **Alertas & Insights** classificados (INFORMAÇÃO/ATENÇÃO/CRÍTICO/POSITIVO).
8. **Itens futuros visíveis** no menu como "em breve" (desabilitados) — ajuda a mostrar o roteiro sem tela falsa.
9. **Dinheiro em centavos inteiros** na camada de cálculo, uma única fonte de verdade fora da UI. Já é a nossa regra (`numeric(18,2)`).

## Conflitos a decidir
| Tema | Ledger Lens | Nosso `UX_UI.md` | Proposta |
|---|---|---|---|
| Tema | escuro por padrão, denso | iOS-inspirado, claro/grafite, raio 12–20px | tokens com **claro e escuro**; padrão claro p/ operação (cobrança), escuro opcional |
| Raio | 8px | 12–20px | manter 12px (nossa regra) |
| Tabelas | rolagem horizontal | mobile em **cards** | mobile em cards (nossa regra) |
| Roteamento/stack | TanStack + Supabase | Next.js + server actions | **portar** componentes; não adotar Supabase |
| Tailwind | v4 (oklch via `@theme`) | v3 | migrar para v4 (projeto novo, custo baixo) |

## O que NÃO copiar
- Backend Supabase (nosso isolamento é por `company_id` no Postgres próprio, com testes).
- Login com Google/criação livre de conta ("Criar conta" aberto): o nosso é **só por convite**.
- `.env` versionado no repositório do Lovable.

## Como o Lovable entra (proposta)
Lovable = agente de UI/UX (política `~/.claude/CLAUDE.md`). Claude Code = orquestra, integra, testa e protege.
1. Briefing por tela, com **dados sintéticos**, sem segredos, sem dados de cliente, sem ai-memory.
2. Lovable gera telas/componentes React + Tailwind + shadcn.
3. Claude Code **revisa o diff**, porta para Next.js (server components/actions), liga aos serviços reais e roda o `pnpm sandbox`.
4. Repositório Git local é a fonte da verdade; o código do Lovable nunca vai direto para produção.
5. Custo: cada mensagem ao Lovable consome créditos do workspace; agrupar pedidos por lote de telas.

---
# Parte 2 — Ideias de infra e de projeto (leitura do código, 2026-10-23)
Lidos: plano de fase (`.lovable/plan`), migrações SQL (roles, RLS, auditoria), `calculo.ts`, `dinheiro.ts`, middleware de auth. Não lido: `.env` do projeto.

## Aproveitar (alto valor, encaixa no nosso roteiro)
| # | Ideia no Ledger Lens | Onde entra no K3G | Como adaptar |
|---|---|---|---|
| 1 | **Camada de cálculo única** ("nenhuma tela recalcula fórmula"), funções puras, dinheiro em **centavos inteiros** | E05, E07, E08, E12 | `src/modules/finance/calc/*` puro e testado; telas só consomem. **No servidor** (SQL/serviço), não no navegador. |
| 2 | **Quatro datas** por lançamento: competência, vencimento, pagamento, movimentação | E05–E08 (charges, bank_transactions) | já alinhado ao nosso "competência M, vencimento M+1"; formalizar nos schemas |
| 3 | **Ciclo de status** PREVISTO/PENDENTE/PAGO\|RECEBIDO/ATRASADO/CANCELADO + conciliação NÃO CONCILIADO/CONCILIADO/DIVERGENTE | E07, E08 | usar o mesmo vocabulário nas telas e no banco |
| 4 | **Regras de ouro**: previsto nunca soma com realizado; transferência e cancelado têm efeito zero no resultado; competência e caixa usam datas diferentes | E08 (transferência entre CNPJs), E12 | virar **testes de invariante** no sandbox |
| 5 | **Auditoria por trigger no Postgres** (valor, categoria, status, conciliação, exclusão: antes → depois), escrita só pelo trigger, leitura só admin | E05+ (tabelas financeiras) | complementa nossa auditoria de aplicação; impossível de burlar por rota nova. Sem PII em texto livre. |
| 6 | **RLS como defesa em profundidade** | E05+ | Codex já apontou "isolamento só na app". Adaptar: `SET LOCAL app.user_id / app.company_ids` por transação + policies por `company_id` (sem `auth.uid()` do Supabase). Testar com role de app sem BYPASSRLS. |
| 7 | **Drill-down até o lançamento** (linhas devolvem um descritor de filtro; `movimentosDaLinha`) | E12 | todo número do dashboard abre os lançamentos de origem |
| 8 | **Validação de fim de fase por conferência numérica cruzada** (soma das movimentações = GRE = fluxo = cards) | sandbox | teste de invariante e2e a cada fase financeira |
| 9 | **Dados demo gerados no banco** (6 meses, consistentes) e não valores fixos na tela | DEMO do dashboard | nosso dashboard hoje tem KPIs **fixos no código**; trocar por seed demo coerente passando pela camada de cálculo, com faixa "DEMO" |
| 10 | **Motor de insights com limiares** (custos +10%, margem −1 p.p., inadimplência >10%, saldo projetado crítico, categoria +20%) | "precisa de atenção" do dashboard | adaptar a cobrança: vencidos, lotes sem aprovação, divergências de conciliação |
| 11 | **Plano de fase em arquivo** com "Validação antes de encerrar" | processo | já usamos `agent/memory` + `BACKLOG`; adicionar seção de validação por fase |
| 12 | Plano de contas hierárquico (`categorias`: tipo, natureza, `ordem_gre`) | E12 | nova entidade `categories` por empresa quando chegar o GRE |

## Não adotar / cuidados (aprendidos lendo o código)
- **Supabase / Lovable Cloud / Google OAuth / "Criar conta" aberto.** O nosso acesso é só por convite. Nas migrações deles dá para ver o custo: começaram com políticas `USING (true)` e `auditoria_insere WITH CHECK (true)` (qualquer logado lia tudo e forjava auditoria) e só depois restringiram (`is_equipe`, `has_role`). **Lição: nunca política permissiva por padrão; testar RLS.**
- **Cálculo no navegador sobre todos os lançamentos** (`useContextoFinanceiro` carrega tudo). Não escala e expõe o conjunto inteiro de dados ao cliente. Nosso cálculo fica no servidor, com agregação em SQL.
- **Direção de transferência codificada em texto livre** (`observacao === "entrada"`). Frágil. Nosso `transfer_pairs` tem origem/destino explícitos.
- **Isolamento multiempresa só "preparado"**: `is_equipe()` é global, sem `company_id` nas policies. O nosso já é por empresa, testado (E02/E03).
- `.env` versionado no repositório do projeto Lovable (conteúdo não verificado).

## Efeito no backlog (proposta)
- **Novo E04.0** (antes de contratos): módulo `finance/calc` (centavos, 4 datas, regime) + testes de invariante no sandbox.
- **E05**: tabelas financeiras já com trigger de auditoria + RLS (defesa em profundidade) e teste com role sem BYPASSRLS.
- **E01 retrofit** (design): dashboard demo vindo de seed coerente, não de números fixos.
- **E12** = o próprio módulo GRE do Ledger Lens, com nosso backend. O Lovable desenha; nós calculamos no servidor.
