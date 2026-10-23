# Estratégia de testes e critérios de entrega

## Por camada
- Unit: datas de faturamento com calendário real, formatação BRL e centavos, permissões, cálculo de saldos, estados de cobrança.
- Integration: banco de dados real isolado em container de testes; migrações up/down quando reversíveis; auth e validações; job claiming idempotente; transações.
- E2E com Playwright: login/logout, seletor de empresa, CRUD, aprovação, prévia de lote e template, mobile 375px, sem vazar dados entre empresas.
- Smoke pós-deploy: HTTPS e certificado, redirect, home→login, login demo testado por operador em ambiente isolado, dashboard, health interno, logs limpos e rollback pronto.
- Segurança: rate limit, replay webhook, mass assignment, CSRF, SSRF (se aplicável), IDOR/tenant boundaries, anexos privados, concorrência e double submit.
- Performance alvo: 51–150 clientes iniciais, sem perf thresholds ambiciosos; páginas responsivas, consultas indexadas por tenant/data, jobs tolerantes a falhas.

## Tabela de casos faturamento
| Serviço / competência | Vencimento | NF conjunta? | Emissão prevista | Observações |
|---|---|---|---|---|
| Outubro/2026 | 05/11/2026 | não | 25/10/2026 | pode ocorrer antes do encerramento da competência |
| Outubro/2026 | 05/11/2026 | sim | 01/11/2026 | boleto + NF juntos |
| Outubro/2026 | 12/11/2026 | sim | 01/11/2026 | NF bloqueia envio se não emitida |
| Outubro/2026 | 13/11/2026 | não | 01/11/2026 | lote 1 |
| Outubro/2026 | 16/11/2026 | não | 01/11/2026 | lote 1 |
| Outubro/2026 | 17/11/2026 | não | 08/11/2026 | lote 8 |
| Outubro/2026 | 22/11/2026 | não | 08/11/2026 | lote 8 |
| Outubro/2026 | 23/11/2026 | não | 15/11/2026 | lote 15 |
| Outubro/2026 | 30/11/2026 | não | 15/11/2026 | lote 15 |
| Outubro/2026 | 31/11/2026 | não | revisão | data inválida; não gerar |
| Janeiro/2027 | 28/02/2027 | não | 15/02/2027 | casos de vencimento 29-31 ainda dependem de política |
| Dezembro/2026 | 05/01/2027 | não | 25/12/2026 | virada do ano; feriado é pendência |

## Critérios de confiabilidade
- Dois usuários concorrentes não criam o mesmo lote/cobrança duas vezes.
- 2 PIX de mesmo valor e data não são conciliados automaticamente sem referência inequívoca.
- Parcelas parciais preservam saldos; estorno não exclui evento original.
- Transferências entre os dois CNPJs não viram faturamento consolidado.
- Os números demo usam label persistente.
- Migrations falham de maneira segura e podem ser revertidas via backup testado.
- Anônimo recebe 401/redirect; perfil não autorizado recebe 403 sem vazamento; cada empresa só acessa dados próprios.

## Gates
E01: lint/typecheck/build/e2e login UI. E02+: integração PostgreSQL e tenant tests. E05+: idempotência, concorrência. E09+: schemas API/webhook. E10+: homologação externa e autorização operacional explícita.
