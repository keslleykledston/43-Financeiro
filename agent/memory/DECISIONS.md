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

## ADR-013 Contratos locais com versões e calendário de faturamento (2026-10-23, E04)
Contratos vivem no Finance (ADR-012). Tabelas `contracts` (termos VIGENTES, numeric(18,2); app em centavos), `contract_versions` (histórico/pendências; 1 pendente por contrato via índice parcial) e `holidays` (por empresa). Mudança de termos = versão pendente, só vigora após aprovação; aprovador ≠ solicitante exceto diretoria; reativar exige `contracts.approve`; suspender/encerrar livre para `contracts.write`; encerrado é definitivo. Permissões: diretoria/gerente read+write+approve; assistente read+write; contabilidade read; admin técnico nenhuma.
Calendário (`src/modules/billing/calendar.ts`, funções puras testadas contra `fixtures/billing_calendar_cases.json`, 12 casos): lotes 25/1/8/15; dia 31 e dia inexistente em mês curto → revisão sem data; feriado em dia ÚTIL na emissão → revisão; fim de semana só aviso (a fixture tem emissão em domingo com review=false). Feriados nacionais calculados (inclui Sexta-feira Santa); municipais/estaduais por empresa. Só contrato ativo + cliente ativo + vigência cobrindo a competência fatura. Nada é emitido nesta fase.

## ADR-014 Provedores das integrações (2026-10-23, respostas do dono)
- **Boleto + extrato/saldo:** Cora (Integração Direta: client ID + certificado X.509 + chave privada, mTLS, token OAuth client-credentials; token em `matls-clients.api.cora.com.br/token` (produção) e `matls-clients.api.stage.cora.com.br/token` (homologação); credenciais só pelo app/Cora Web; uma credencial por CNPJ). **Credenciais AINDA NÃO existem** → construir tudo com Cora SIMULADA; homologação quando o dono gerar as credenciais. Campos/endpoints exatos, idempotência e limites NÃO estão no índice público da doc: verificar em homologação, não presumir.
- **NFS-e:** emissor = **NFS-e da Cora (beta)**. Pendente confirmar cobertura do município e dos CNAEs da K3G antes de qualquer emissão. Cora NFS-e fica atrás de `FiscalProvider` + flag desligada.
- **WhatsApp:** **WAHA** (não oficial) — dono ciente do risco de bloqueio do número. Mitigações obrigatórias: opt-in/lista de destinatários revisada, janela de horário, limite de taxa e jitter, kill switch, stop-on-payment, texto sem pressão/ameaça, número dedicado (não o principal). API oficial da Meta fica como caminho futuro via `MessageChannel`.
- **E-mail:** **SMTP do domínio k3gsolutions.com.br**. Exige SPF/DKIM/DMARC e remetente por empresa; limites de envio e pouca visibilidade de entrega (sem webhook de bounce): tratar bounce por caixa de retorno/erro SMTP e limitar taxa.
- Tudo atrás de feature flags DESLIGADAS (`BILLING_LIVE_ENABLED`, `EMAIL_EXTERNAL_ENABLED`, `CORA_LIVE_ENABLED`, `FISCAL_LIVE_ENABLED`, + `WHATSAPP_LIVE_ENABLED`) e do gate E10 (homologação, calendário fiscal aprovado, autorização explícita, limites). Ordem de construção: E05 (prévia+aprovação de lote) → E06 (templates e fila em simulação) → E09 (adapters com mocks: Cora, NFS-e, SMTP, WAHA; agendador) → E10 (real, por provedor, um de cada vez).

## ADR-015 Vigência: contrato vale 12 meses e renova sozinho (2026-10-24, dono)
- Palavras do dono: "REGRA De contrato é por padrao 12 meses, renovado automaticamente apos este periodo caso nao haja manifestacao do cliente".
- Efeito: `end_at` nulo = renovação automática; data final só quando o cliente (ou a K3G) encerra. Alertas em `/contratos/alertas` (renovação, reajuste, fim informado). A cobrança não muda. Suspenso ainda renova (suposição minha, a confirmar). PRD §4.

## ADR-016 Comissão de parceiros (2026-10-24, dono) — E18
- Respostas do dono: percentual **por contrato**; base = **valor mensal do contrato**; "No dia 16 é pago a comissão do que recebeu do mes anterior. Ex.: 16/10 é pago os 30% dos valores recebidos dos clientes no mes 09".
- Implementação: cobrança entra no mês em que ficou totalmente paga (data da última baixa); fechamento mensal congela as linhas (imutáveis); pagamento é registrado à mão; mudar parceiro/percentual com recebimento fora de fechamento é bloqueado. Migração 0022.

## ADR-017 Escopo da Cora: só boletos (2026-10-24, dono) — E19
- Palavras do dono: "Nao vai ser feito nada de pagamento pela plataforma, apenas emissao de boletos, validacao de status dos boletos, acompanhamento se foi pago, se esta atrasado ou coisa assim. no maximo emissao de segunda via de boleto. mas nada de manusear o $$ na conta. (segurança)".
- Depois: "pode autorizar a cancelar o boleto via plataforma (porem sob autorizacao de diretoria - limitacao de usuario)" e "tudo deve ficar registrado devidamente".
- Escopo permitido (`CORA_SCOPE`): emitir, consultar situação, segunda via e **cancelar (somente diretoria, com motivo, tudo registrado)**. Proibido, estruturalmente (interfaces, testes): pagar, transferir, Pix enviado, saldo/extrato. A conciliação não usa a API da Cora.
- Credenciais (client id, certificado e chave) em Integrações → Cora: cifradas (AES-256-GCM, chave `K3G_CREDENTIALS_KEY` em `.env.credentials`), escrita apenas, só diretoria, auditadas. Guardar não liga a emissão real (E10b segue BLOQUEADA até homologação + autorização escrita). Migração 0023.
- Cancelamento de boleto: fluxo próprio na fase E20 (registro imutável de quem, quando, por quê e resultado; só diretoria).

## ADR-018 Aditivos, comentários e dados da empresa (2026-10-24, pedido do dono) — E21
- Pedido: "o administrador possa editar os dados das empresas e contratos, assim como fazer aditivos ou comentários, e ajuste de valores". "Administrador" = diretoria (admin técnico não lê dados financeiros).
- Aditivo reaproveita o fluxo de versões do contrato (proposta → aprovação). Acrescenta tipo, data de efeito, referência do documento. A data de efeito **não pode ser futura**: a cobrança lê o valor vigente do contrato na prévia do lote, então um aditivo agendado exigiria aplicação automática na data (fica no backlog). Cobranças já geradas nunca mudam.
- Diretoria ganhou "Aprovar agora" (propõe+aprova, dois eventos no registro): coerente com a exceção já existente em `decideVersion`. Gerente e assistente seguem o fluxo de dois olhos.
- Comentários: tabela `notes` só de acréscimo (trigger). Permissão = quem escreve no cadastro (contracts.write / crm.write). Texto não vai para o registro de atividades.
- Dados da empresa: permissão nova `company.manage` (só diretoria); CNPJ validado (inclui alfanumérico) e único; auditoria grava só os nomes dos campos alterados.
- Cliente do CRM continua somente leitura (a sincronização sobrescreveria). Correção de nome/CNPJ vai no CRM.

## ADR-019 Conta de e-mail por empresa e dados da contabilidade/fiscais (2026-10-24, pedido do dono) — E22
- Pedido: em Integrações, os campos da conta de e-mail para envio; em Dados da empresa, os dados do contador/escritório "e o que precisar para não depender".
- E-mail: tabela `email_accounts` (uma por empresa). Usuário e senha CIFRADOS no mesmo cofre da Cora (AAD `empresa|smtp|campo`), escrita apenas; servidor, porta, segurança e remetente aparecem. Em branco = mantém. Só diretoria (`providers.credentials`). Leitura em claro só em `email-secrets.ts`, protegido por teste de guarda (nenhum outro arquivo importa). Guardar NÃO liga o envio.
- Segurança do servidor digitado: só nome público (sem IP/localhost/nomes internos) e portas 465/587/2525/25, com segurança coerente com a porta (SSL só na 465); impede usar a tela para varrer a rede interna quando o adaptador real existir. Nome do remetente sem aspas, < >, @, ; ou quebra de linha (injeção de cabeçalho). Sem botão de "enviar teste": nada sai antes da autorização escrita (E10b).
- Contabilidade/fiscal: tabela `company_fiscal` (contador: nome, CPF/CNPJ validado, CRC, contato, e-mail, telefone, observações; fiscal: regime, inscrição municipal, CNAE, código LC 116, alíquota ISS, ISS retido, endereço estruturado, IBGE). Só diretoria (`company.manage`). O painel lista, campo a campo, o que falta para a NFS-e e para a contabilidade, e o portão de emissão ganhou o item "dados fiscais preenchidos". Não emite nota nem fala com a prefeitura.
- Não guardamos senha de portal de prefeitura nem certificado digital A1 da empresa (se a NFS-e exigir, será fase própria com o mesmo cofre).

## ADR-020 Adaptador de e-mail REAL (canário) com travas triplas (2026-10-24, "pode seguir" do dono) — E23
- O dono mandou seguir com o adaptador de e-mail. Construir o adaptador **não** é liberar o envio: a regra "sem e-mail real antes de autorização explícita" continua. O envio real só acontece com **três travas ao mesmo tempo**: (1) `EMAIL_EXTERNAL_ENABLED=true` no `docker-compose.yml` (mudança versionada, feita por quem opera; **não foi feita**); (2) autorização ATIVA registrada pela diretoria em Integrações (referência do documento escrito, lista de destinatários, limite diário; histórico imutável, só revoga); (3) conta SMTP cadastrada e legível no processo.
- Canário: só para a lista autorizada (endereço exato, ou o domínio inteiro apenas do próprio remetente); reconferida no adaptador. Boleto, NFS-e e WhatsApp seguem simulados; a mensagem de cobrança **ainda não leva boleto** (não existe boleto real até o adaptador da Cora; placeholders entram na fase da Cora).
- Padrão reservar → enviar fora de transação → registrar (`runEmailLive`). Resultado desconhecido (queda depois de enviar o conteúdo) **nunca** é reenviado sozinho: bloqueia para revisão humana. "enviando" travado >10 min vira desconhecido. `message_queue` e `email_send_log` ficam imutáveis depois do envio (triggers); registro só guarda domínios, nunca endereços.
- SSRF (Codex E22 P2): o nome do servidor é resolvido no envio e só conecta a IP público; o IP validado é o usado na conexão (sem rebinding), TLS ≥1.2 com certificado verificado pelo nome, sem anexos/arquivos/URLs, tempos limite, sem pool. Conta lida em claro só em `email-live.ts` (teste de guarda).
- Se o real está liberado mas bloqueado (cofre indisponível, conta removida), os e-mails ficam **na fila** (nem enviados, nem "simulados"). O **agendador nunca envia e-mail real** (Codex E23 P1): o real do canário é só pelo botão "Processar fila". Revogar a autorização (mesmo lock da reserva + reconferência antes de cada entrega ao SMTP) interrompe o que ainda não foi entregue. Dependência nova: `nodemailer` 8 (mantida pelo projeto Nodemailer; só roda no servidor, só em `smtp.ts`).
- Aviso no topo muda para "E-MAIL REAL ATIVO (canário)" quando chave + autorização estão ligadas na empresa.

