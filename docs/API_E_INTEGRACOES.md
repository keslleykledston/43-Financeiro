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
- `MockAdapter`: dados sintéticos, aceita respostas sucesso, erro, timeout e resultado incerto para simulação.

## Integrações reais: condições de liberação
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
