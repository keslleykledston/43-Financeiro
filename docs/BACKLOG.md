# Backlog por microentregas — entregue, mostre, teste, documente

Legenda: `[ ]` pendente, `[x]` concluído **somente após verificação real**. A cada entrega: commit Git, testes, screenshot se possível, URL/rota demonstrável, changelog e artigo `help/`.

## E00 — Host seguro e base de trabalho [ ]
Saída: inventário read-only, repo privado, `.gitignore`, Node + Docker Compose (se disponíveis), decisão sobre porta livre, Nginx sem conflito, estratégia HTTPS e backup.
Aceite: `preflight.sh` executado; nada existente alterado; `docs/DEPLOY.md` atualizado com resultados verificados; bloqueios anotados. Se DNS não existe, continuar em localhost.

## E01 — Primeiro 'wow' visual [ ]
Saída: app Next.js, design system iOS-inspired original, login funcional seguro (sem credencial padrão), shell, sidebar, mobile bottom navigation, seletor de empresa, dashboard **DEMONSTRAÇÃO** com dados sintéticos e marca d'água "Dados fictícios"; páginas placeholders úteis Clientes/Contratos/Faturamento/Contas a receber/Conciliação/Configuração; ajuda.
Aceite: login/logout, acesso anônimo bloqueado, navegação sem 404, layout responsivo 375px e desktop, contraste/teclado básicos, testes smoke e proteção HTTPS antes de dados reais; domínio acessível se pré-condições verificadas.

## E02 — Usuários e empresa [ ]
Saída: Companies 2 registros sem CNPJ real pré-preenchido, memberships, convites, RBAC, papéis admin técnico/diretoria/gerente/assistente/contabilidade, trilha de auditoria, alternância de contexto, permissões demonstráveis.
Aceite: empresa A não enxerga B sem membership; negativa server-side; convite expira; usuário removido perde acesso; teste com dois usuários e dois tenants; ajuda.

## E03 — Clientes e fornecedores [ ]
Saída: CRUD com filtros, busca, validação CPF/CNPJ quando aplicável, contato financeiro, histórico, importação CSV simulada/revisável, exportação autorizada.
Aceite: campos obrigatórios, documento duplicado conforme regra de tenant, pesquisa, paginação, exclusão lógica quando há vínculos, help.

## E03b — Integração CRM: clientes (e base para contratos) [ ]
Pedido do dono: clientes e contratos vêm do **CRM via API**. Saída: `CrmAdapter` + mock + servidor CRM fake no sandbox; `source/external_id/external_synced_at` em customers; sincronização incremental com **prévia e confirmação**, fila de conflitos, `integration_sync_runs`, tela *Integrações* (estado, última execução, "Sincronizar agora"); kill switch `CRM_SYNC_ENABLED=false`. Cadastro manual/CSV continua como fallback marcado `source`.
Aceite: reimportar não duplica; conflito com cadastro manual vai para revisão; cliente inativo no CRM é arquivado (não apagado); falhas (429/timeout/payload inválido) não derrubam o app; sem PII em logs; teste e2e com CRM fake. **Conexão real só com CRM identificado, credencial read-only e autorização explícita.**

## E04 — Contratos e calendário pós-pago [x] (2026-10-23; ver ADR-013)
(**Contratos são cadastrados e mantidos AQUI** — o K3G CRM não tem contratos (decisão do dono, ADR-012). Ligados a `customers` (de origem CRM ou local); só clientes com situação **ativo** geram cobrança. Mudança de valor/vencimento gera versão (`contract_versions`) e exige aprovação antes de afetar cobrança.)
Saída: CRUD de contratos, valor, empresa, cliente, vigência, due_day, flag NF conjunta, competência anterior, agenda com lotes 25/1/8/15, alerta dia 31 e meses curtos.
Aceite: testes tabelados para dias 1, 5, 12, 13, 16, 17, 22, 23, 30, 31, mês/ano novo, fev; competência M e vencimento M+1; ajustes não fazem alterações silenciosas.

## E05 — Prévia + aprovação de lote [x] (revisado pelo Codex, P1+P2 corrigidos)
Saída: serviço idempotente de gerar prévias, lista por empresa, filtros por lote, resumo total, sinalização de exceções, aprovação humana auditável e sem operações externas.
Aceite: reexecutar lote não duplica cobrança; status aprovado só por papel autorizado; alterações pós-aprovação exigem nova validação; help.

## E06 — E-mails editáveis (modo simulação) [x]
Saída: editor de templates por empresa/tipo, placeholders restritos, prévia com dados fictícios, versão/ativação, fila de envios DEMO e histórico; templates de faturamento, D-3, D0, D+3, D+7 e revisão D+15.
Aceite: preview correto, sanitização HTML/injeção, sem e-mail externo real, filas sem duplicatas, aviso "Simulação".

## E07 — Contas a receber [~]
**E07a [x]** lista/filtros/indicadores/envelhecimento/devedores, baixa manual parcial ou total, estorno, histórico, CSV, parada da régua ao quitar, trigger de teto no banco. **E07b [ ]** anexos privados (comprovantes): armazenamento de arquivos com validação e revisão própria.
Saída: listagem por competência/vencimento/status, pagamento parcial manual autorizado, anexos privados, inadimplência, cálculo não destrutivo.
Aceite: não marcar quitado antes de soma de alocações/liquidação, exportar CSV, histórico de eventos, relatórios por CNPJ.

## E08 — Conciliação [~]
**E08a [x]** contas, importação OFX/CSV genérico com prévia e dedup, saldo pelo extrato, sugestão segura (documento + valor), vínculo parcial/múltiplo, desfazer, classificação, triggers de imutabilidade. **E08b [ ]** pareamento de transferências entre CNPJs, layout validado do CSV da Cora com arquivo real, regras de auto-vínculo (se autorizadas).
Saída: importação CSV e OFX **quando formato validado**, prévia de importação, dedup, matching seguro, pendências, vínculo parcial, estorno, transferência entre CNPJs.
Aceite: extrato repetido não duplica; dois PIX iguais não autoassociam sem identificador; saldo segue movimentos; histórico e rollback controlado.

## E09 — APIs e adapters [~]
**E09a [x]** provedores simulados (e-mail, WhatsApp, boleto/extrato Cora, NFS-e Cora) com falha fechada se chave *_LIVE ligar, janela/limites/pausa/tolerância, agendador (serviço `scheduler`), tela Configuração e painel de provedores. **E09b [ ]** abaixo (API pública).
Saída: `/api/v1` com OpenAPI, API key hashed scopes/expiry/revocation, rate limiting, exemplos curl sem segredo, webhooks com teste HMAC, mock adapters Cora/e-NF/e-mail.
Aceite: contrato OpenAPI e testes auth/no cross-tenant/replay/idempotência; sandbox simulada.

## E10 — Emissão e envio REAL (GATE DE SEGURANÇA) [~]
**E10a [x]** motor de emissão SIMULADO (reservar→chamar→registrar, reconsulta, idempotência, limites, pausa, checklist do portão, `docs/E10_GOLIVE.md`). **E10b [ ] BLOQUEADO** adaptadores reais: exigem credenciais, homologação e autorização escrita (ver go-live).
Pré-requisitos: disponibilidade documentada da API por CNPJ, homologação Cora e e-NF, calendário fiscal aprovado, credenciais guardadas fora Git, aprovação explícita de habilitação e limites de envio. Implementar um provedor por vez; flag desligada inicialmente.
Aceite: emissão teste homologação, confirmação/reconsulta remota, comprovantes e falha segura, reconciliação, e-mails canários internos, kill switch; NUNCA executar em produção por conveniência.
Pré-requisito (Codex E06, P2): antes de qualquer envio real, a FK `message_queue.charge_id` deve virar RESTRICT e `cancelBatch`/`generateBatch` devem marcar cobranças como `cancelada` em vez de apagar, preservando o histórico de envios.

## E11 — Contas a pagar [~]
**E11a [x]** fornecedores, lançamento, aprovação com alçada e segregação, duplicidade, fila de execução, baixa manual com protocolo, estorno, CSV, integração com o painel (A pagar e saídas 13 semanas). **E11b [ ]** anexos privados (nota/boleto; junto com o E07b).
Saída: fornecedores, vencimentos, anexos, aprovações, exportação e controle da execução manual no Cora.
Aceite: sem executar pagamento pela app; logs, permissão de alçada, duplicidade, vencimento.

## E12 — Inteligência financeira MVP [x]
(Entregue sem contas a pagar: o fluxo projetado é só de ENTRADAS e diz isso na tela. Saídas entram quando o E11 existir. PDF/CSV do painel: não necessários agora.)
Saída: dashboard empresa/grupo, faturado vs recebido, a receber/a pagar, fluxo projetado 13 semanas (com indicação de qualidade), gráficos explicativos, sem IA generativa necessária.
Aceite: números rastreáveis, sem duplicar intercompany, notas de dados ausentes, PDF/CSV só se necessários, ajuda.

## DoD obrigatório por entrega
- [ ] UI real acessível e útil para teste; demonstração identificada.
- [ ] Segurança e company scope revisados; sem credenciais no repo.
- [ ] `typecheck`, lint, testes e build aprovados ou falhas registradas.
- [ ] Revisão independente em fluxo de risco, P0/P1 corrigidos.
- [ ] Help por tela e screenshots/roteiro.
- [ ] Deploy com rollback e smoke por HTTPS quando aplicável.
- [ ] `NOW.md`, `CHANGELOG.md`, `DECISIONS.md`/ADR e checklist atualizados.

## Descobertas da planilha real de boletos 2026 (analisada em 2026-10-23; nenhum dado importado; sem dados pessoais aqui)
- Planilha com 10 abas (JAN–OUT/2026); cada aba tem 2 blocos: **K3G Solutions** (VALOR BRUTO × LÍQUIDO × DATA PG, 44→69 clientes/mês, ~R$ 89 mil→124 mil) e **K3G Call** (**Plano + Excedente** + Líquido, 14→19 clientes/mês). Somas batem exatamente com as linhas de TOTAL da planilha (serve de teste de fechamento).
- **Lacuna 1 — FEITA (E05c): excedente variável da K3G Call, lançado à mão por contrato/competência (confirmado pelo dono: calculado em outro sistema).** A cobrança da Call = plano fixo + excedente mensal (6 de 20 clientes tiveram excedente). O contrato só tem valor mensal fixo: precisa de ajuste/excedente por competência antes de aprovar o lote.
- **Lacuna 2 — FEITA (E07c): juros, multa e desconto na baixa manual e na conciliação.** Em 79 pagamentos o LÍQUIDO é maior que o BRUTO (juros/multa) e em 17 é menor (desconto/retenção). Hoje a baixa não passa do saldo. Precisa registrar principal × acréscimos × desconto.
- Pagamentos parciais em duas datas existem (ex.: "24/03;14/04"): o modelo atual cobre.
- 20 de 75 clientes mudaram de valor no ano e 15 de 75 têm dia de vencimento variável: usar o valor/dia mais recente no contrato e mostrar o histórico.
- Cruzamento com o sistema (contagens): 48 de 70 CNPJs da planilha (Solutions) já estão no CRM importado; 22 não (4 CNPJs inválidos, 5 sem CNPJ, 13+ não cadastrados); K3G Call não tem nenhum cliente cadastrado (20 na planilha, 11 também são clientes da Solutions).
- Proposta: importação de contratos e clientes (K3G Call, locais) a partir da planilha + **carga histórica** dos boletos de 2026 como histórico fechado (painel e inadimplência com dados reais), validada contra os totais da planilha. Só com autorização explícita para dados reais.

## E14 — Importação de contratos da planilha (2026-10-23)
- Decisões do dono: "medina" = contrato com comissão para o parceiro Medina (marca `contracts.commission_partner`, informativa até haver cálculo de comissões); vale o valor do **mês mais recente**; vencimento = dia mais comum; clientes da **K3G Call** entram como cadastro local; os da Solutions que faltam no CRM ficam como **pendência** (o dono acerta no CRM).
- FEITO (migração 0020): conversor puro `src/modules/contracts/planilha.ts` + `scripts/planilha-para-csv.ts` (xlsx → CSV, roda só no container de ferramentas); importação com prévia/confirmação (`src/modules/contracts/import.ts`, tela Contratos → Importar); lote em rascunho aprovado/rejeitado de uma vez (quem importou não aprova, exceto diretoria); reimportar é seguro.
- NÃO FEITO: execução com os dados reais (exige autorização expressa e o reenvio do `.xlsx`, que não ficou no servidor); carga histórica 2026 (cobranças/baixas fechadas, validada contra os totais da planilha); edição da marca de comissão depois da importação; cálculo/relatório de comissões.

**Importação real (2026-10-24):** autorizada por escrito; 66 contratos em rascunho (Solutions 47, Call 19; 19 clientes locais da Call criados), 29 linhas pendentes (CNPJ ausente/inválido ou fora do CRM). Células com vários e-mails: vale o primeiro válido. Script operacional `scripts/ops-import-contracts.ts` (prévia por padrão; `OPS_CONFIRM=1` grava; auditado). Falta: dono aprovar os lotes; corrigir pendências no CRM e reimportar; carga histórica 2026 (nova autorização).

## E15 — Segurança operacional (2026-10-24)
- [x] Revogação de sessões: troca de senha e "Sair em todos os dispositivos" (users.session_version, migração 0021).
- [x] Registro de atividades `/auditoria` (audit.read; isolado por empresa; filtros; paginação; dados pessoais mascarados).
- [x] Restore do backup validado manualmente (`scripts/restore-test.sh`).
- [ ] 2FA (TOTP) para diretoria/admin.
- [ ] Agendar restore-test periódico (cron semanal) — decisão do dono, altera o crontab do host.

## E16 — Central de ajuda (2026-10-24)
- [x] `/ajuda` (lista) e `/ajuda/<artigo>` renderizando `help/*.md`; botão "?" no cabeçalho abre o artigo da tela.
- [ ] Busca dentro da ajuda; capturas de tela ilustrativas sem dados reais.

## E17 — Alertas de contratos (2026-10-24)
- [x] `/contratos/alertas`: vigência terminada / termina em breve e reajuste em atraso / próximo (janela 30/60/90 dias); aviso no topo de `/contratos`. Só leitura, sem migração.
- [x] Regra do dono: contrato vale 12 meses e renova sozinho; sem data final = renovação automática (alerta `renovacao_proxima`, junto do reajuste quando coincidem).
- [x] Regra de reajuste: 12 meses desde o início ou desde a última versão aprovada que mudou o valor.
- [ ] Índice (IPCA/IGP-M) e percentual de reajuste por contrato; "adiar/ignorar alerta"; aviso por e-mail à diretoria (depende de E10b).

## E18 — Comissão de parceiros (2026-10-24)
- [x] Regra do dono: percentual POR CONTRATO sobre o valor mensal, das cobranças quitadas no mês anterior; pago no dia 16 (ex.: 16/10 paga o recebido em setembro).
- [x] Migração 0022: `contracts.commission_bps`, `commission_statements` (fechamento: fechado → pago | cancelado), `commission_lines` (congeladas, imutáveis). Telas `/comissoes` (prévia, fechar, pagar, cancelar, CSV) e bloco "Comissão de parceiro" no contrato. Permissões `commissions.read` (diretoria, gerente, contabilidade) e `commissions.manage` (diretoria, gerente).
- [ ] Comissão proporcional a cobrança parcial; lançamento de acerto quando há estorno depois do pagamento; gerar a conta a pagar do parceiro (E11); ajuste do percentual em lote.

## E19 — Área do Cora em Integrações (2026-10-24)
- [x] Seção "Cora — boletos": escopo só de boletos (emitir, consultar situação, segunda via; nunca pagamento/transferência/saldo/extrato), credenciais por empresa e ambiente (homologação/produção), guardadas CIFRADAS (AES-256-GCM, migração 0023), escrita apenas, validação do certificado/chave, aviso de vencimento. Só diretoria (`providers.credentials`).
- [ ] E10b (adaptador real de boletos: emitir/consultar/segunda via/webhook de status) — BLOQUEADO até homologação + autorização escrita. Atualizar o checklist quando o adaptador existir.
- [ ] Segunda via na tela da cobrança; acompanhar "pago/atrasado" pela situação do boleto (baixa automática) quando o adaptador existir.

## E20 — Cancelar boleto pela plataforma (autorizado pelo dono em 2026-10-24, ADR-017)
- [x] Só diretoria (`boletos.cancel`), motivo + confirmação, só boleto emitido e sem pagamento; reservar → chamar o provedor → registrar; `desconhecido` + reconsulta (5 tentativas); registro IMUTÁVEL em `boleto_cancellations` (migração 0024) + auditoria; nova emissão com chave de idempotência nova (`:gN`); interrompe a régua da cobrança. Provedor simulado.
- [ ] Pedido de cancelamento por gerente/assistente com aprovação da diretoria (hoje só a diretoria cancela, como autorizado).
- [ ] Cancelamento em lote; cancelamento no adaptador real (E10b, depois da homologação).

## E21 — Aditivos, comentários e dados da empresa (pedido do dono, 2026-10-24)
- [x] Aditivo = versão do contrato com tipo (alteração, reajuste, ajuste de valor, prorrogação, outros), data de efeito (não futura), referência do documento e motivo; aprovação pelo fluxo atual; diretoria pode "Aprovar agora" (registra quem pediu e quem aprovou); alerta de reajuste conta a partir da data de efeito (migração 0025).
- [x] Comentários só de acréscimo em contrato e cliente (trigger recusa editar/apagar; texto fora do registro de atividades).
- [x] Dados da empresa (nome, razão social, CNPJ validado e único, e-mail financeiro, endereço): só diretoria, auditado (só nomes dos campos).
- [ ] Aditivo agendado (data futura aplicada sozinha na data) — hoje a data de efeito não pode ser futura.
- [ ] Cliente do CRM: correção de nome/CNPJ continua no CRM (somente leitura aqui); aguardando o dono dizer o que está errado em "19.534.417 LTDA".
- [ ] H1 (histórico a partir das abas da planilha) — aguarda "pode seguir" e respostas (docs/HISTORICO_E_CAIXA.md §6).
- [ ] Endurecer o papel de banco da aplicação (sem TRUNCATE/DDL; papel de migração separado) — protege as tabelas só-de-acréscimo (notes, commission_*, boleto_cancellations). Ver review E21 #2.

## E22 — Conta de e-mail e dados da contabilidade/fiscais (pedido do dono, 2026-10-24, ADR-019)
- [x] Integrações → "E-mail (SMTP)": servidor, porta, segurança, remetente, resposta, usuário/senha cifrados (escrita apenas), só diretoria (migração 0026).
- [x] Dados da empresa → "Contabilidade e dados fiscais": contador/escritório + dados fiscais da NFS-e, com lista do que falta; item novo no portão.
- [ ] Adaptador SMTP real + enviar com o boleto (E10b-1), canário interno; SPF/DKIM/DMARC e bounce.
- [ ] Certificado digital A1 / credenciais de prefeitura, se a NFS-e da Cora exigir (cofre; fase própria).
- [ ] Papel "contabilidade" ver (somente leitura) os dados fiscais da empresa.

- [ ] (Codex E22 P2) Adaptador SMTP real: resolver DNS (A/AAAA) na hora de conectar, bloquear faixas internas/loopback/link-local, proteger contra DNS rebinding e restringir o egress do container. A validação atual só barra IP literal e nomes internos comuns.
- [ ] (Codex E22 P2) Código do serviço (LC 116) só confere o formato: validar contra a lista aceita pela prefeitura quando a NFS-e for ligada; até lá, confirmar com o contador.

## E23 — Adaptador de e-mail real (canário) (2026-10-24, ADR-020)
- [x] Adaptador SMTP (nodemailer) com proteção SSRF, TLS verificado, lista de destinatários, tempos limite; reservar → enviar → registrar; desconhecido nunca reenvia; registro imutável (migração 0027).
- [x] Integrações → "Envio real — canário": autorização (referência, lista, limite diário), revogar, e-mail de teste, últimos envios. Banner do topo muda quando ativo.
- [ ] **NÃO LIGADO**: ligar exige autorização escrita do dono + trocar `EMAIL_EXTERNAL_ENABLED` no docker-compose.yml + registrar a autorização na tela + SPF/DKIM/DMARC do domínio. Passo a passo em docs/E10_GOLIVE.md.
- [ ] Boleto na mensagem (link/linha digitável/PDF) — depende do adaptador da Cora (E10b-2).
- [ ] Tratamento de e-mail devolvido (bounce) e cabeçalhos de lista (List-Unsubscribe) antes de sair do canário.
- [ ] Envio automático real pelo scheduler: hoje PROIBIDO de propósito (Codex E23 P1); só reabrir com decisão do dono depois do canário.

## H1 — Histórico da planilha: staging + divergências (2026-10-24, ADR-021)
- [x] Tabelas `legacy_imports`/`legacy_billing_rows` (migração 0028), script `ops-import-legacy`, tela /historico (por aba, caixa por mês de pagamento, divergências, CSV), artigo de ajuda.
- [ ] Dono revisar as divergências (CSV) — principalmente CNPJ ausente/inválido, fora do cadastro, vencimento fora da aba, pagamentos >120 dias.
- [ ] H2: linha do tempo de clientes/contratos (entrou, mudou valor/vencimento, suspenso, voltou, saiu) inferida do staging; corrigir início de vigência; gerar aditivos "inferidos da planilha".
- [ ] H3: cobranças e baixas históricas (origin = 'historico', lote próprio fora da emissão/régua) — NOVA autorização escrita do dono.
- [ ] H4: caixa por data de pagamento + conferência com extrato real da Cora (falta amostra CSV/OFX) e despesas (dono envia depois).
- [x] (H1) Datas em formato americano detectadas e corrigidas só na análise; pagamento em texto vira divergência; correção de CNPJ/CPF pelo Histórico com validador (pedido do dono).
- [ ] Usar as correções de CNPJ no passo de contratos: os 4+1 clientes "CNPJ inválido" não importados em E14 podem virar contratos em rascunho depois de corrigidos (precisa de decisão do dono).
- [ ] Edição de cliente vindo do CRM (hoje somente leitura): precisaria de "correção local" que a sincronização respeite; só se o dono pedir.

## E26 — Cliente: caixa Editar; Configurações da empresa (2026-10-24, ADR-022)
- [x] Cliente > Editar em abas (dados com validador de CNPJ, endereço, texto da nota fiscal e do boleto, anotações, contatos); migração 0030; textos/endereço chegam ao provedor simulado.
- [x] Menu Configurações (Empresa · Usuários e acessos · Registro de atividades); Empresa agrupa cadastro, endereço, contabilidade e dados fiscais.
- [ ] Mapear `instructions` (boleto) e `customerAddress`/`description` (NFS-e) nos adaptadores reais da Cora (E10b).
- [ ] Texto da nota/boleto por CONTRATO (hoje é por cliente) se o dono precisar de texto diferente por contrato.
- [ ] Remover a coluna `companies.address` (sem uso) em limpeza futura.


## E27 — Acesso: primeiro acesso, convites e redefinição de senha (2026-10-25, ADR-023)
- [x] Convite com entrada direta (nome + senha com confirmação + força, já loga), convites pendentes (novo link / cancelar), política única de senha.
- [x] "Esqueci minha senha" (resposta sempre igual) + `/redefinir/[token]` (uso único, 60 min) + link de nova senha gerado pela diretoria (24 h) + `scripts/ops-reset-link.ts`.
- [x] E-mail do sistema (senha/convite) pelas mesmas travas do envio real; migração 0031. **E-mail real NÃO ligado** (depende da autorização escrita e da conta SMTP).
- [ ] Ligar o canário de e-mail incluindo os endereços dos usuários na lista autorizada (docs/E10_GOLIVE.md) para o "esqueci minha senha" enviar de verdade.
- [ ] Aviso por e-mail "sua senha foi alterada"; 2FA.

## D1 — Despesas: categorias, centros, sócios, conta-corrente (2026-10-25, planilha Despesas__2026)
- [x] Categorias (~30 padrão, editáveis), centros de custo, sócios; conta-corrente dos sócios (retirada, despesa paga pelo sócio, devolução, reembolso, compensação nos lucros); contas a pagar com categoria/centro/competência; migração 0032.
- [ ] D2: recorrências (Vivo, energia, Simples, salário…), parcelas (empréstimos, consórcio, carro) com saldo e compromissos futuros, calendário de pagamentos.
- [ ] D3: importar Despesas__2026.xlsx em staging com classificação sugerida (exige autorização escrita) + cruzar com extratos bancários.
- [ ] D4: plano de retiradas e previsão de lucro (receita pelos contratos, despesas recorrentes e parcelas, limite de retirada sugerido, cenários).
- [ ] D5: fatura de cartão aberta em compras; D6: conciliação com extrato Cora/OFX.
- [ ] Mostrar sócios/categorias no painel; relatório de despesas por categoria/mês/centro.
