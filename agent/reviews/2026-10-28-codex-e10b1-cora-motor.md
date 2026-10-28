# Revisão Codex (somente leitura) — E10b-1 motor de emissão ligado à Cora de TESTES (2026-10-28)
Escopo: `cora-boleto.ts`, `cora-http.ts`, `registry.ts`, `errors.ts`, `issuance/service.ts` e `cancel.ts`, migração 0042 (colunas, CHECKs, gatilho), tela de Emissões, compose, testes e script ponta a ponta.
Veredito inicial: **BLOQUEIA** (1 P1). Após as correções: sem P0/P1 abertos.

| Sev. | Achado | Tratamento |
|---|---|---|
| — | Nenhum caminho para emitir/cancelar na PRODUÇÃO da Cora; modo real exige as 3 travas; gerente não troca o provedor | Confirmado pelo Codex; sem ação |
| P1 | Corrida em `processIssuance`: o provedor era resolvido antes da transação de reserva; se a configuração mudasse no intervalo, a linha seria gravada com um modo e chamada com outro provedor (fallback simulado) | Corrigido: a reserva confere que a configuração lida na transação é a mesma usada para resolver o provedor (senão não reserva nada e pede nova rodada) e que o modo existe no mapa (senão `LiveNotAvailable`) |
| P2 | `find` só olhava os 40 primeiros candidatos por página; boleto entre os itens 41–100 não era achado → reemissão | Corrigido: confere todos os candidatos (até 150 detalhes); acima disso lança `busca_incompleta` (o motor trata como desconhecido e repete a reconsulta; nunca reemite às cegas). Teste cobre achar o 78º, lista sem o boleto e limite estourado |
| P2 | 401/429 tratados como "repetível" dependem de a Cora não ter criado o boleto nesses casos | Aceito: a documentação da Cora define 401 = token recusado e 429 = limite antes do processamento; e a repetição usa a MESMA `Idempotency-Key`, então mesmo no pior caso a Cora devolve o mesmo boleto (provado no teste real: mesma chave = mesmo boleto) |
| P2 | Migração 0042 sem rollback documentado | Já documentado em `docs/OPERACAO.md` (linha 0042: reversão só se não houver boleto da Cora de testes; senão manter a migração e voltar a empresa para `simulado`) |
| nota | `last_error` impresso no script ponta a ponta | Só recebe códigos internos curtos (testado: sem nome/documento do cliente) |

Testes: integração com Cora falsa com estado (9 cenários), unidade do adaptador e do cliente, e **ponta a ponta REAL no stage** (`scripts/ops-cora-e2e-stage.ts`, banco descartável, dados fictícios, CNPJ alfanumérico).
