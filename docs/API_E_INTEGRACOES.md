# API e integrações — contrato de construção

## Objetivo
Permitir integração futura sem depender de um provedor específico e manter segurança por CNPJ. Construir contratos e adaptadores mock antes de conectar serviços reais.

## API pública futura
Base `/api/v1`. OpenAPI em `/api/openapi.json` com documentação restrita para operações administrativas se aplicável. Versão v1 mantém compatibilidade semântica por período definido, erros `{code, message, requestId, details?}`, paginação `limit`+cursor, timestamps ISO 8601 UTC, moeda BRL em string decimal (`"2500.00"`) ou centavos inteiros, nunca float.

MVP endpoints:
- `GET /api/v1/me`: usuário e escopos permitidos.
- `GET /api/v1/companies`: empresas acessíveis.
- `GET/POST/PATCH /api/v1/customers` (+ item id).
- `GET/POST/PATCH /api/v1/contracts` (+ item id).
- `GET/POST /api/v1/billing/batches`, `POST /.../{id}/review`, `POST /.../{id}/approve` com controle de concorrência.
- `GET /api/v1/charges` (+ detalhes e eventos).
- `GET/POST/PATCH /api/v1/email/templates`, `POST /.../preview` sem enviar.
- `POST /api/v1/bank-imports` com idempotência, `GET /.../reconciliations`.
- `GET /api/v1/reports/summary?companyId=...` (empresa deve ser autorizada).
- `GET /api/v1/health` apenas código simples de liveness; readiness profunda interna.

## Autenticação
UI: sessão/cookie seguros + CSRF. Integração server-to-server: chave gerada randômica, apenas HASH armazenado, scope limitado, empresa permitida, expiração, rate limit, rotação/revogação. Endpoints webhooks validam assinatura e timestamp, replay e idempotência. Nunca confiar no campo `company_id` do payload sem resolver pela credencial/conexão.

## Contratos dos conectores
- `CoraAdapter` interface métodos `fetchTransactions(account, cursor)`, `fetchBalance(account)`, `issueSlip(request, idempotencyKey)`, `lookupSlip(externalId)`.
- `ENFAdapter` `issueInvoice(request,idempotencyKey)`, `lookupInvoice(externalId)`, `cancelInvoice(externalId)` (último exige autorização/caso de uso).
- `EmailAdapter` `sendEmail(templateRendered, recipients, idempotencyKey)`, `lookupDelivery(messageId)`.
- `CrmAdapter` (**fonte de verdade de clientes e contratos**, somente leitura na v1): `listCustomers(cursor, updatedSince?)`, `getCustomer(externalId)`, `listContracts(cursor, updatedSince?)`, `getContract(externalId)`. Retorna payloads validados por Zod; nunca grava no CRM.
- `MockAdapter`: dados sintéticos, aceita respostas sucesso, erro, timeout e resultado incerto para simulação.

## Integração CRM (clientes e contratos) — regras de construção
O CRM da K3G é a **fonte de verdade** de cadastro de clientes e de contratos; o K3G Finance **importa** e não escreve de volta (v1). Pedido do dono do produto em 2026-10-23.
- **Identidade externa:** `customers`/`contracts` guardam `source` (manual|crm|csv), `external_id` e `external_synced_at`; único `(company_id, source, external_id)`. Reimportar **não duplica** (upsert idempotente).
- **Prévia antes de aplicar** (mesmo padrão do CSV): sincronização gera diff (novos, alterados, removidos/inativos, conflitos); humano confirma. Execuções ficam em `integration_sync_runs` (contagens, erros, duração, quem confirmou).
- **Conflitos nunca sobrescrevem em silêncio:** cadastro manual com o mesmo documento, empresa/CNPJ emissor ambíguo, valor ou vencimento de contrato alterado → fila de revisão humana. Alteração de contrato cria `contract_versions` e **não afeta cobrança futura sem aprovação** (dinheiro real).
- **Campos do CRM são somente leitura na UI** para registros `source=crm`; contatos financeiros adicionais podem ser locais e marcados como tal.
- **Empresa/CNPJ emissor:** regra configurável por conexão (campo do CRM → empresa do K3G Finance, 2 CNPJs), ambíguos vão para revisão. Uma conexão por empresa (`integration_connections`), isolamento por `company_id`.
- **Regras que o CRM não traz** (NF conjunta, `issue_day_override`, política de vencimento) ficam no K3G Finance com feature flag/aprovação humana.
- **Modo de sincronização:** incremental (`updated_since`/cursor), agendado por job + botão "Sincronizar agora" com prévia; kill switch `CRM_SYNC_ENABLED=false` por padrão.
- **Robustez:** timeout, retry com backoff e jitter, respeito a 429/Retry-After, paginação e respostas parciais, circuit breaker simples; falha do CRM nunca derruba o app. Webhook (se existir) só complementa o cursor, com assinatura verificada.
- **LGPD/segurança:** importar só o necessário (documento, razão social, e-mails financeiros, telefone); sem PII em logs/auditoria; credencial **somente leitura**, por conexão, fora do Git/prompt/Lovable, HTTPS obrigatório.
- **Testes (sandbox):** servidor CRM fake com fixtures — PF/PJ, CNPJ alfanumérico, duplicados, cliente inativo/removido, contrato com valor alterado, página 2, 429, timeout, payload inválido, resposta parcial.
- **Liberação real exige:** identificar o CRM, documentação da API, credencial read-only por empresa, autorização explícita para importar dados reais, teste em amostra e revisão independente.

## Integrações reais: condições de liberação
- **CRM:** confirmar qual sistema é, URL base/documentação da API, método de autenticação, campos de contrato (valor, vigência, dia de vencimento, status, serviço), como identificar a empresa/CNPJ emissor e se há webhook. Ver seção acima.
- Confirmar documentação e acesso por conta Cora, com credenciais distintas dos dois CNPJs. Cora API pública existente não garante liberação/cobertura de endpoint.
- Confirmar se sistema **e-NF específico** usado pela K3G tem API e regras fiscais. Em falha/inexistência, pode existir exportação/registro manual auditável como fallback temporário; não fingir integração.
- Email: escolher provedor com SPF, DKIM, DMARC, bounces, webhooks de entrega e limites de envio; usar contas remetentes por empresa.
- Não capturar tela de app bancário como integração padrão; não automatizar login com senha humana sem revisão de segurança e termos.
- Boletos e notas fiscais reais devem ficar em modo OFF até autorização humana e homologação. Ações externas sempre idempotentes; status `UNKNOWN` requer consulta remota antes de retry.
- Webhooks podem chegar atrasados, duplicados, fora de ordem; cursor periódico complementa eventos. Verificar assinatura antes de registrar como confiável.

## Testes dos adapters
Mock cria boleto? **Não**, apenas registro simulado. Testar cenário timeout após emissão, reconsulta e reconciliação sem segunda emissão; dois eventos duplicados, pagamento parcial, falha fiscal, cancelamento, bounce email e pausa cobrança.

## Referências a consultar no host (sempre docs oficiais atualizadas)
- Cora: https://developers.cora.com.br/
- Lovable MCP: https://github.com/lovablelabs/mcp
- OpenAPI: https://spec.openapis.org/oas/latest.html
