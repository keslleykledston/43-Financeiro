# ADR-whatsapp-001 — Módulo WhatsApp (WAHA, não oficial): entrega 1 de 4

Data: 2026-10-29 · Status: entrega 1 implementada · Origem: pacote `Financeiro_WG_WhatsApp_WAHA_Implementacao_v1` (specs de referência, não código).

## Contexto e nome do projeto
O pacote chama o produto de «Financeiro_WG». O projeto real é o **K3G Finance** (`43-Financeiro`), com as empresas K3G Solutions e K3G Call. Onde o pacote diz «WG» (ex.: «atendido pela WG»), o texto do produto usa o nome real da empresa que cobra («remetente transparente»). Nenhuma stack foi trocada.

## Gate 0 — diagnóstico do repositório (verificado em 2026-10-29)
| Tema | Estado real |
|---|---|
| Stack | Next.js 15 (App Router, server actions), React 19, TS, Tailwind 4, Drizzle + postgres.js (PostgreSQL 16), Auth.js v5, Vitest, Playwright, pnpm; tudo em Docker (`web`, `scheduler`, `db`, `tools`) |
| Multiempresa | `company_id` em toda tabela; `memberships` ativas dão as empresas do usuário; empresa corrente vem do **servidor** (cookie validado), nunca do formulário |
| RBAC | papéis `admin_tecnico`, `diretoria`, `gerente`, `assistente`, `contabilidade` em `identity/permissions.ts`; `requirePerm(db, user, company, perm)` em todo serviço. **Não existe `platform_admin`** global |
| Mensageria existente | `messaging/*`: modelos, fila por cobrança, janela/limites por empresa (`messaging_settings`), e-mail real com 3 travas (E23/E33). Canal `whatsapp` existe na fila, **sempre simulado**; chave antiga `WHATSAPP_LIVE_ENABLED` é «chave geral» (ligada, recusa TODA emissão real) e fica desligada |
| Padrão de «envio real» | e-mail: chave do servidor + autorização registrada na tela (referência, destinatários exatos, limite) + log permanente de tentativas; reaproveitado aqui |
| Cora | `providers/cora-*` (só boletos); baixa automática por sync/webhook; **WhatsApp ainda não toca em cobrança** |
| Docs/ajuda | `help/*.md` + `help/routes` (botão «?» do cabeçalho); ADRs em `agent/memory/DECISIONS.md`; revisões em `agent/reviews/` |
| Gate de entrega | `pnpm sandbox` (stack isolada: tsc + 600+ testes + e2e) → Codex read-only → backup → migração → deploy → smoke |

Lacunas relevantes: sem papel de plataforma; sem tabela de consentimento por contato (entrega 2); sem receptor de webhook da WAHA (entrega 3); sem leitura de contas a receber para régua (entrega 4).

## Spike de compatibilidade (obrigatório pelo pacote) — resultados reais
Imagem **`devlikeapro/waha:gows-2026.8.2`** (digest `sha256:23f2d002d262b54c711af02b5fe79b1948bbf31e6b64cf7776cd6bd2f7477b47`), já presente no servidor (usada por outro projeto; não foi tocada). Container descartável, rede própria, sem portas, chaves aleatórias:
- `GET /ping` sem chave = 200; **todo `/api/*` sem `X-Api-Key` = 401**; `GET /api/server/version` → `{version:2026.8.2, engine:GOWS, tier:CORE}`; Swagger/painel desligados = 404.
- `POST /api/sessions {name,start}` cria; **o CORE desta versão aceitou 2 sessões simultâneas** (o pacote assume N sessões; confirmar no upgrade de versão — pode mudar).
- Estados observados: `STOPPED → STARTING → SCAN_QR_CODE`; `FAILED` quando o container não tem saída para a internet (**a rede do WAHA não pode ser `internal`**: precisa sair para o WhatsApp, sem porta publicada).
- `GET /api/{sessão}/auth/qr`: com `Accept: application/json` → `{mimetype, data(base64)}`; sem → **PNG**. Fora de `SCAN_QR_CODE` → 422 `{status, expected:[SCAN_QR_CODE]}`.
- `POST /api/sendText` sem login → **422** `expected:[WORKING]`. Envio real e formato da resposta **não testados** (exige aparelho): coberto por teste de contrato com fake e validado no canário.
- Webhook: headers `X-Webhook-Hmac` (**sha512 hex do corpo bruto**, conferido em 5 eventos), `X-Webhook-Hmac-Algorithm`, `X-Webhook-Timestamp` (ms), `X-Webhook-Request-Id`; corpo `{id: "evt_…", event, session, payload}`. Receptor fica para a entrega 3. Fixtures sanitizadas em `tests/fixtures/waha/`.
- Risco registrado: outro projeto do servidor relatou **pareamento recusado pelo WhatsApp** em IP de datacenter. Se o QR não parear, é bloqueio do lado do WhatsApp, não bug nosso; sem contornos técnicos.

## Decisões
1. **Sem `platform_admin`.** A conexão (`whatsapp_sessions`) é compartilhável, mas nasce **vinculada à empresa que a criou** (`whatsapp_session_companies`, com «remetente transparente»). Só empresas com vínculo ativo a veem; as demais recebem o mesmo «não encontrada» (sem vazar existência). Criar/QR/pausar/desconectar = `whatsapp.manage` (diretoria, admin técnico); autorizar envio = `whatsapp.authorize` (só diretoria); enviar teste = `whatsapp.send` (diretoria, gerente). Vincular uma 2ª empresa (exigirá diretoria das duas) fica para a **entrega 2**.
2. **Chaves do servidor** (separadas da antiga `WHATSAPP_LIVE_ENABLED`, que continua a chave geral desligada): `WHATSAPP_MODULE_ENABLED` (gerenciar conexão/QR; não envia), `WHATSAPP_SEND_ENABLED` (envio manual de teste; **desligada** até ordem do dono), `WHATSAPP_AUTOMATION_ENABLED` (réguas; **desligada**, ainda sem código).
3. **WAHA só na rede interna** (`expose`, sem `ports`), imagem fixada por digest, painel/Swagger desligados, chave em `.env.waha` (fora do Git, leitura negada ao assistente), nunca no navegador nem no banco. Um único arquivo (`providers/waha.ts`) fala com a WAHA; teste automatizado garante.
4. **Guardrails desde o 1º envio** (lista de verificação única usada pela tela e pelo envio): chave do servidor, módulo/WAHA, conexão vinculada, não pausada e **conectada** (estado relido na WAHA antes de enviar), empresa não pausada, autorização ativa com o **número exato**, número individual `55…@c.us` (grupo/lista/transmissão recusados), janela de envio da empresa (Manaus, dias, feriados), limites diários (autorização ≤10, empresa 10, conexão 20 somando as empresas), confirmação humana. Todo bloqueio mostra o motivo e é auditado.
5. **Sem retry automático e sem duplicidade:** reservar o registro (`enviando`, com trava por conexão e empresa) → chamar a WAHA fora da transação → fechar o registro. Tempo esgotado/queda/5xx = `desconhecido` («pode ter chegado»), contado no limite, nunca reenviado sozinho. Registro de envios e autorizações são só-de-acréscimo (gatilhos + anti-TRUNCATE).
6. **Privacidade:** o id devolvido pela WAHA (traz o telefone) é guardado só como **SHA-256 (32 hex)** — `refHash` em `whatsapp/domain.ts`; a entrega 3 correlaciona ACKs aplicando o mesmo hash ao id recebido. logs e auditoria só com telefone mascarado e sem texto; QR só por rota autenticada `no-store`; erros do adaptador carregam código curto, nunca corpo, QR, chave ou telefone.
7. Texto do teste é **fixo**, sem dado de cliente, sem link e **sem «responda PARAR»** (não existe recebimento de respostas antes da entrega 3: prometer opt-out seria enganoso).
8. Lovable (MCP): **não usado** nesta entrega — o design system do repositório e o protótipo do pacote bastaram, e a política do servidor é não gastar créditos quando o trabalho local é eficiente.

## Achado do 1º envio real (2026-10-29) e correção
O 1º teste (conexão pareada, número do dono) falhou com 500 da WAHA: `no LID found for <número>@s.whatsapp.net`. O motor **GOWS só envia depois de resolver o número**. Correção: antes do `sendText`, `GET /api/contacts/check-exists` (não envia nada). Para o número do dono a WAHA devolveu o id canônico **sem o 9º dígito** (conta antiga do WhatsApp). Regra de segurança: o destino só vale se for o número **autorizado** — igual, ou a equivalência oficial do 9º dígito de celular (`sameBrNumber`: mesmo DDD, mesmos 8 finais, 8-dígito de celular 6–9). Sem id individual, com outro número ou fora do WhatsApp: nada sai (`falhou`). O limite diário conta tentativas reservadas (inclui consultas sem envio): conservador de propósito.

## Entrega 2 (2026-10-29): vínculo entre empresas, consentimento e opt-out, bloqueios
- **Vínculo (`bindCompany`)**: uma conexão, um QR, N empresas (máx. 5). Exige `whatsapp.authorize` (diretoria) **nas duas** empresas — a da conexão e a que entra; quem não é membro da empresa-alvo recebe 403 sem revelar se ela existe. A empresa que entra nasce **sem autorização de envio e sem consentimentos**, com remetente próprio. Sair (`unbindCompany`): diretoria da própria empresa; a última empresa não sai (usar desconectar). Revogar bloqueia na hora (a conexão só vale com vínculo ativo). Nomes de empresas só aparecem a quem também é membro delas.
- **Aceito/documentado:** quem é diretoria de uma empresa vinculada também pode pausar/desconectar a conexão compartilhada (efeito comum a todas); limites diários da conexão (20) e o risco de restrição são compartilhados. Aprovação em duas pessoas (uma de cada empresa) fica para depois: hoje basta UMA pessoa que seja diretoria nas duas.
- **Consentimento (`whatsapp_consents`, migração 0047, só-de-acréscimo)**: estado = evento mais recente. `scope=company` (vale para a empresa) ou `global` (o contato pediu para não receber nada neste número, de nenhuma empresa). **Opt-out global prevalece sobre tudo; só outro global desfaz; opt-in da empresa não o desfaz.** Global só a diretoria registra; o estado global aparece às outras empresas só como «pediu para parar», sem dizer quem. Prova = fonte + referência (sem dado pessoal). Repetir o mesmo estado é recusado.
- **Envio:** o opt-out bloqueia o teste mesmo com o número autorizado, e é revalidado depois da consulta do número, no último instante. O teste continua exigindo a **autorização por número** (não exige opt-in: é para contato interno); envio a cliente (entregas 3/4) exigirá opt-in da empresa.
- **Revisão Codex (decisões):** (1) o TESTE vale pela autorização por número (contato interno), não por opt-in; a lista de verificação mostra o consentimento como informação, e **envio a cliente exigirá opt-in da empresa** (entregas 3/4). (2) Desfazer um opt-out GLOBAL é possível (o cliente pode pedir para voltar) mas só pela diretoria e **só com prova escrita, formulário ou iniciada pelo cliente — nunca verbal**. (3) A prova rejeita e-mail, telefone, CPF/CNPJ e sequências longas de dígitos. (4) Nome **e remetente** de empresa alheia ficam ocultos. (5) Janela residual de milissegundos entre a última conferência de opt-out e a chamada à WAHA: não dá para serializar uma chamada externa sem prender o banco; o pedido registrado depois vale para as PRÓXIMAS mensagens. (6) Pausar/desconectar numa conexão compartilhada afeta todas as empresas — avisado na tela e na ajuda.
- **Bloqueios:** `/whatsapp/teste` lista os últimos envios bloqueados com o motivo (a auditoria guarda só chaves de motivo, sem número/texto).
- **Risco de sabotagem avaliado:** a diretoria de uma empresa pode registrar opt-out global e bloquear o número para todas. Aceito: é o comportamento de segurança desejado («na dúvida, bloquear mais amplamente»), auditado com autor e prova.

## Fora desta entrega (próximas)
2: FEITA (acima). 3: modelos/aprovação, fila/outbox, receptor de webhook com HMAC sha512, caixa de entrada e triagem. 4: régua D-3/D0/D+3 **desativada**, releitura da dívida no envio, cancelamento por baixa da Cora, painel. Nenhuma automação habilitada em produção sem aprovação do dono.

## Rollback
Desligar `WHATSAPP_MODULE_ENABLED`/`WHATSAPP_SEND_ENABLED` e `docker compose stop waha`. Migração 0046 é **aditiva** (4 tabelas novas, sem tocar nas existentes): reverter só o código; as tabelas ficam (histórico imutável). Detalhe em `docs/OPERACAO.md`.
