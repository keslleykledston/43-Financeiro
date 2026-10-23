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

## E07 — Contas a receber [ ]
Saída: listagem por competência/vencimento/status, pagamento parcial manual autorizado, anexos privados, inadimplência, cálculo não destrutivo.
Aceite: não marcar quitado antes de soma de alocações/liquidação, exportar CSV, histórico de eventos, relatórios por CNPJ.

## E08 — Conciliação [ ]
Saída: importação CSV e OFX **quando formato validado**, prévia de importação, dedup, matching seguro, pendências, vínculo parcial, estorno, transferência entre CNPJs.
Aceite: extrato repetido não duplica; dois PIX iguais não autoassociam sem identificador; saldo segue movimentos; histórico e rollback controlado.

## E09 — APIs e adapters [~]
**E09a [x]** provedores simulados (e-mail, WhatsApp, boleto/extrato Cora, NFS-e Cora) com falha fechada se chave *_LIVE ligar, janela/limites/pausa/tolerância, agendador (serviço `scheduler`), tela Configuração e painel de provedores. **E09b [ ]** abaixo (API pública).
Saída: `/api/v1` com OpenAPI, API key hashed scopes/expiry/revocation, rate limiting, exemplos curl sem segredo, webhooks com teste HMAC, mock adapters Cora/e-NF/e-mail.
Aceite: contrato OpenAPI e testes auth/no cross-tenant/replay/idempotência; sandbox simulada.

## E10 — Emissão e envio REAL (GATE DE SEGURANÇA) [ ]
Pré-requisitos: disponibilidade documentada da API por CNPJ, homologação Cora e e-NF, calendário fiscal aprovado, credenciais guardadas fora Git, aprovação explícita de habilitação e limites de envio. Implementar um provedor por vez; flag desligada inicialmente.
Aceite: emissão teste homologação, confirmação/reconsulta remota, comprovantes e falha segura, reconciliação, e-mails canários internos, kill switch; NUNCA executar em produção por conveniência.
Pré-requisito (Codex E06, P2): antes de qualquer envio real, a FK `message_queue.charge_id` deve virar RESTRICT e `cancelBatch`/`generateBatch` devem marcar cobranças como `cancelada` em vez de apagar, preservando o histórico de envios.

## E11 — Contas a pagar [ ]
Saída: fornecedores, vencimentos, anexos, aprovações, exportação e controle da execução manual no Cora.
Aceite: sem executar pagamento pela app; logs, permissão de alçada, duplicidade, vencimento.

## E12 — Inteligência financeira MVP [ ]
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
