# E10 — Portão da emissão e do envio REAIS (go-live)

**Estado hoje:** o motor de emissão existe e funciona só com provedores **simulados**. O banco recusa (`CHECK mode = 'simulado'`), o registro de provedores falha fechado se alguma chave `*_LIVE_ENABLED` for ligada e não existe adaptador real. Nada sai do sistema. **Nunca habilitar por conveniência.**

## O que o sistema já tem (E10a, simulado)
- Motor reservar → chamar o provedor fora de transação → registrar (`src/modules/issuance`).
- Chave de idempotência fixa por (empresa, cobrança, tipo): a mesma cobrança nunca é emitida duas vezes no provedor.
- Resposta perdida/erro inesperado/processo que caiu = `desconhecido`: a próxima rodada **reconsulta** (`find`) antes de qualquer nova emissão; sem resposta conclusiva após 5 tentativas, vai para revisão humana.
- NFS-e assíncrona (beta): `processando` → consulta de status → `emitida`.
- Começa **pausado**, limite diário, kill switch, auditoria só com ids/contagens, lote com emissão não pode ser reaberto.

## O que o USUÁRIO precisa providenciar (nada disso está no Git nem no chat)
1. **Cora:** client-id, certificado e chave mTLS por CNPJ, habilitação de boletos v2/extrato/webhooks e da NFS-e (beta). Confirmar limites e idempotência na homologação.
2. **NFS-e:** dados fiscais e do contador preenchidos em Dados da empresa (pronto desde a E22); confirmar cobertura do município e CNAEs dos dois CNPJs; calendário fiscal aprovado por quem responde pela contabilidade.
3. **E-mail:** conta SMTP cadastrada em Integrações → E-mail (SMTP) (pronto desde a E22; guardar não liga o envio), SPF/DKIM/DMARC do domínio, remetente por empresa, tratamento de devolução.
4. **WhatsApp (WAHA):** chave, número dedicado, lista de **opt-in** revisada, janelas e limites aprovados.
5. **Autorização escrita da diretoria**, por provedor e por empresa, com limites de envio.

## Escopo da Cora (decisão do dono, 2026-10-24)
Só **boletos**: emitir, consultar situação (emitido/pago/atrasado), segunda via e **cancelar (somente diretoria, com motivo, tudo registrado; fase E20)**. **Nunca** pagamento, transferência, Pix enviado, saldo/extrato (por isso a conciliação não usa a API da Cora). Ver ADR-017. Definido em `src/modules/providers/cora.ts` (`CORA_SCOPE`) e coberto por teste.

## Como os segredos entram (sem passar por chat, Git ou Lovable)
Duas vias, ambas fora do Git e do chat: (a) a seção **Cora — boletos** em *Integrações* (diretoria; guardado CIFRADO no banco, escrita apenas, chave `K3G_CREDENTIALS_KEY`, em `.env.credentials` (0600, fora do Git; sem ela cai em `AUTH_SECRET`). Perder ou trocar essa chave exige cadastrar as credenciais de novo. Faça cópia dela junto dos demais segredos) ou (b) arquivos montados em `/run/secrets`, abaixo. Guardar credenciais NÃO liga a emissão real.
Arquivos de 1 linha em um diretório **fora do repositório**, permissão 600, montados **somente-leitura** em `/run/secrets` (Compose `secrets:`):
`cora_client_id`, `cora_cert.pem`, `cora_key.pem`, `smtp_user`, `smtp_password`, `waha_api_key`.
O checklist em *Integrações → Portão da emissão real* só confere se os arquivos existem; nunca lê o conteúdo.

## Como ligar o canário de e-mail (E23) — só com autorização escrita do dono
O adaptador existe, mas **está desligado**. Para o canário (e-mails reais só para a lista autorizada), nesta ordem:
1. Conta SMTP cadastrada em Integrações → E-mail (SMTP) (E22). SPF/DKIM/DMARC do domínio prontos.
2. Autorização escrita do dono (e-mail/ata). Em Integrações → Envio real → **Registrar autorização**: referência do documento, lista de destinatários (comece só com endereços internos), limite diário pequeno (ex.: 10).
3. Quem opera o servidor muda `EMAIL_EXTERNAL_ENABLED` de `"false"` para `"true"` em `docker-compose.yml` (commit), rebuild e restart do `web`. O topo do sistema passa a mostrar **E-MAIL REAL ATIVO (canário)**.
4. **Enviar teste** para um endereço interno; conferir chegada (e spam).
5. Só então processar a fila (botão em Mensagens): vão só os e-mails cujo destinatário está na lista; o resto fica bloqueado com o motivo.
**Desligar (kill switch):** *Revogar autorização* (imediato), ou `paused` em Mensagens, ou voltar a chave para `"false"`.

## Ordem de habilitação (um provedor por vez, cada passo com sandbox + revisão do Codex)
1. **Canário interno de e-mail:** só para endereços internos, limite pequeno, kill switch testado.
2. **Cora homologação** (boleto/extrato) com a conta de teste; reconsulta, cancelamento e conciliação conferidos.
3. **NFS-e** em homologação; só depois produção limitada.
4. **WhatsApp** por último, só com opt-in.
5. Produção **limitada** (poucos clientes, limite diário baixo) com acompanhamento; estado declarado como `LIMITED_INTERNAL_PRODUCTION_CANDIDATE` só após gate formal. Nunca "pronto para produção".

## Requisitos de CÓDIGO que a migração do modo real precisa cumprir (pendências aceitas na simulação)
- `message_queue.charge_id` e `issuance_requests.charge_id` → FK **RESTRICT**; `cancelBatch`/`generateBatch` passam a marcar cobranças como `cancelada` em vez de apagar (preserva histórico de envios e emissões). *(Codex E06 P2)*
- Mensagens (`runQueue`) adotam reservar → enviar → registrar (hoje a chamada ao provedor simulado roda dentro da transação).
- Adaptadores reais mapeiam: rede/timeout → `IssuanceTimeout`; recusa antes de processar → `IssuanceRetryable`; validação → `RangeError`. Qualquer outro erro é tratado como `desconhecido` (seguro).
- `env_file` mínimo para o `scheduler` (sem credenciais que ele não usa). *(Codex E09)*
- Teste de contrato contra o ambiente de homologação de cada provedor; teste de timeout após emissão; evento duplicado; pagamento parcial.
- CHECK `mode` ampliado **somente** nessa migração, com backup e rollback documentados em `docs/OPERACAO.md`.
- **O provedor DEVE honrar a chave de idempotência** (`Idempotency-Key` ou equivalente): se uma rodada lenta terminar depois de outra já ter reconsultado e reemitido, a mesma chave garante um único documento. Validar na homologação (enviar a mesma chave duas vezes e conferir que há um só boleto/nota).
- O timeout da chamada ao provedor nos adaptadores deve ser **menor** que o tempo de recuperação de "enviando" travado (`STUCK_MS`, 10 min). Usar `AbortSignal` com ~30 s.
- A injeção de provedores só existe sob o executor de testes (`resolveProviders` recusa fora de `VITEST`); adaptadores reais entram pelo registro, nunca por parâmetro.
