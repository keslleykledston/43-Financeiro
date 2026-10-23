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

## ADR-007 Banco = desenho do starter (docs/ARQUITETURA.md) (2026-10-23, ordem do usuário) — substitui ADR-004 no que diz respeito às tabelas
O banco é o **Postgres 16 próprio (Docker)** com o esquema do desenho original; nada de Supabase/tabelas do Ledger Lens. `parties` foi dividida em `customers`, `customer_contacts`, `vendors`, `vendor_contacts` (migração 0005 preserva dados, testada em banco temporário). Tipo (cliente/fornecedor) não muda após criado. Colunas `source` (manual|csv|crm), `external_id`, `external_synced_at` já existem para a integração CRM.
Variações conscientes do desenho: perfis em enum + mapa de permissões no código (não tabelas `roles/permissions/role_permissions`, a revisitar se papéis ficarem editáveis); sessão = JWT do Auth.js (sem tabela `sessions`); extras necessários: `invitations`, `rate_limits`.

## ADR-008 CRM é a fonte de verdade de clientes e contratos (2026-10-23, pedido do usuário)
Importação via API, somente leitura, com prévia/conflitos/aprovação (docs/API_E_INTEGRACOES.md, fase E03b). Qual CRM e credenciais: pendente de informação do usuário. CRM real só com credencial read-only, fora do Git, e autorização explícita.

## ADR-009 Dois cenários de clientes por empresa: LOCAL ou CRM (2026-10-23, pedido do usuário)
`companies.customer_mode` = `local` (padrão) | `crm`. **Local:** clientes e fornecedores cadastrados/importados (CSV) na plataforma; sincronização com o CRM recusada. **CRM:** clientes (e, no E04, contratos) vêm do CRM, somente leitura; cadastro manual e CSV de *clientes* bloqueados; fornecedores continuam locais. Imposto no servidor (createParty, import CSV, update/archive, remover contato, sync) e só refletido na tela. Trocar o modo exige `integrations.manage` + `crm.write` (diretoria) e é auditado (`company.customer_mode_changed`). No modo local cadastros `source=crm` ficam editáveis; ao voltar ao modo CRM o sync sobrescreve os campos vinculados (aviso na tela). Contatos locais adicionais valem nos dois modos. Modo é por empresa (as duas empresas podem escolher diferente).

## ADR-010 Porte do design do protótipo Lovable para o Next.js (2026-10-23)
Tailwind 4 (`@tailwindcss/postcss`), tokens oklch claro+escuro em `src/app/globals.css`, fontes self-hosted (`@fontsource`: Space Grotesk + IBM Plex Sans, sem CDN), tema claro padrão com toggle persistido em localStorage + script inline no <head> (sem piscar). Componentes em `src/components/k3g/` (app-link → next/link, primitives, states, button, shell, nav). Páginas existentes migradas das cores fixas para tokens semânticos. Mantidos: server actions e papéis acessíveis usados pelos e2e (banner `role=status`, `p[role=alert]`). `/design-system` (autenticada) lista tokens e componentes. Pendente do protótipo: dashboard rico com gráficos (Recharts) fica para o E12 com dados reais; botão de ajuda sem destino ainda (falta rota /ajuda). Capturas de revisão visual geradas pelo sandbox em e2e-results/shots.

## ADR-011 Conector real do K3G CRM (2026-10-23)
CRM = **K3G CRM** (`https://api.k3gsolutions.com.br/api`, OpenAPI público em `/openapi.json`, auth `Authorization: Bearer`, token herda seções/IP allowlist/validade do usuário). Verificado contra a API real só com estrutura e agregados (`pnpm crm:discover`, `crm:profile`, `crm:plan`; nunca valores): `GET crm/companies` devolve TODAS as 146 empresas de uma vez (ignora paginação) em `{companies:[…]}`; `crmStatus` ∈ PROSPECT(82) | ACTIVE(42) | CHURNED(11) | INACTIVE(11); `cnpj` já formatado, 122 válidos, 1 duplicado no CRM; **contratos, contatos e faturas: endpoints existem mas vêm VAZIOS (_count=0)** — contratos não estão neste CRM. Sem filtro incremental (updatedAfter ignorado): sync = listagem completa.
Regra de negócio adotada (pendente de confirmação do usuário): só `ACTIVE` é cliente; CHURNED/INACTIVE arquivam; PROSPECT nunca entra. Configurável por `CRM_ACTIVE_STATUSES`. Simulação real: 42 criariam (todos com CNPJ válido), 0 conflitos. Provider padrão `k3g`; `canonical` para referência/testes. Sync real continua DESLIGADO (CRM_SYNC_ENABLED ausente) até autorização explícita.

## ADR-012 Situação do cliente + contratos são locais (2026-10-23, respostas do dono)
1. **Situação do cliente** (`customers.status`: ativo | suspenso | cancelado; CHECK no banco). Só **ativo** é faturável (`isBillable`). Suspenso e cancelado **continuam clientes** (podem ter dívidas antigas a receber) mas não geram nova cobrança. Mapeamento K3G CRM: ACTIVE→ativo, INACTIVE→suspenso, CHURNED→cancelado; PROSPECT (e desconhecidos) **não são clientes** (nunca importados; se já existiam, arquivam). Substitui a regra anterior de arquivar CHURNED/INACTIVE. Configurável por `CRM_STATUS_MAP`. No modo local a situação é editável no cadastro e aceita coluna `situacao` no CSV.
2. Os clientes do CRM pertencem à **K3G Solutions** (a K3G Call não usa o CRM; fica em modo local). Os clientes do CRM cobrem o grupo.
3. **Contratos não existem no K3G CRM** (endpoints vazios). Serão **cadastrados e mantidos na plataforma Finance (E04)**, ligados a `customers` (de origem CRM ou local). Fonte de verdade de contrato = Finance.
4. `CRM_SYNC_ENABLED=true` ligado no servidor por ordem do dono (2026-10-23, em docker-compose.yml). Não importa nada sozinho: exige modo CRM + conexão ativada + confirmação da prévia por diretoria. Simulação real (só contagens): 64 clientes (42 ativos + 22 suspensos/cancelados): 63 entrariam e 1 vira conflito (CNPJ duplicado no próprio CRM); 82 prospects ignorados.
