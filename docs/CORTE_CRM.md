# Corte do CRM — o K3G Finance vira a fonte dos clientes (ADR-043)

Pedido do dono (2026-11-09): a plataforma **para de buscar clientes no CRM** e passa a ser a **fonte da verdade**. O K3G Finance gerencia clientes, **contratos e a situação dos contratos**, e então **atua no CRM**: ajusta a situação do cliente (ativo, suspenso, cancelado…) e **cria o cliente no CRM** quando entra cliente novo.

## O que está construído (lado K3G Finance)
| Peça | Onde | Regra |
|---|---|---|
| Corte | Integrações → «Corte do CRM» | Só diretoria; frase **CORTE**; sem conflito aberto; última sincronização ≤ 24 h (ou aceite explícito de que mudanças feitas no CRM depois dela se perdem). Uma vez só, não volta. |
| Efeito do corte | `companies.crm_cutover_at` | Empresa vai para modo **local** (tudo editável), conexão de leitura **desligada**, sincronização recusada, voltar ao modo CRM bloqueado. Trava de situação some. |
| Fila de saída | tabela `crm_outbox` | Mudança de situação e cliente novo/CSV entram **na mesma transação** da mudança (nada se perde). Um pedido aberto por cliente e tipo (vale o mais recente). Só depois do corte. |
| Envio | `writeback.ts` + agendador (1/min) | Desligado sem `CRM_WRITEBACK_ENABLED=true` **e** `CRM_WRITE_TOKEN`: a fila só acumula. Valor enviado = situação **atual** do cliente. Cliente sem vínculo: procura pelo CNPJ no CRM (vincula, não duplica); não achou → cria. Rede/5xx: repete com espera (2 min dobrando, máx. 6 h, 8 tentativas); 4xx: «falhou» (botão «Tentar de novo»). Criar nunca repete sozinho. |
| Situação a partir dos contratos | ficha do cliente | Sugestão (um clique): algum contrato ativo → ativo; senão algum suspenso → suspenso; senão todos encerrados → cancelado; só rascunho → nada. Quem aplica é uma pessoa; reativar exige gerente/diretoria. |
| Clientes sem cadastro no CRM | Integrações → «Envio ao CRM» | Botão enfileira a criação dos que ainda não existem lá (diretoria). |

Mapa de situação (editável por `CRM_STATUS_MAP`): ativo → `ACTIVE`, suspenso → `INACTIVE`, cancelado → `CHURNED`.

## Ordem para virar a chave
1. Fazer a **última sincronização** (Integrações → Sincronizar) e resolver conflitos.
2. **Corte** (Integrações → Corte do CRM). A leitura acaba aqui. As mudanças passam a ficar na fila.
3. Quando a equipe do CRM liberar (abaixo): configurar `CRM_WRITE_TOKEN` (+ `CRM_WRITEBACK_ENABLED=true`, `CRM_CREATE_PATH`) no `.env.crm` do servidor e reiniciar `scheduler`. A fila acumulada sai sozinha.
4. «Enviar ao CRM os N clientes sem cadastro lá» (conferir a lista antes).

## O QUE PRECISAMOS DA EQUIPE DO CRM
A OpenAPI pública (`/openapi.json`, v1.61.1) mostra só `GET /api/crm/companies`, `GET`/`PATCH /api/crm/companies/{id}` e **não há `POST /api/crm/companies`**; os corpos de escrita vêm sem schema. Por isso não dá para fechar o envio sem:
1. **Token de escrita** (API key) para o K3G Finance, separado do de leitura: com permissão de `PATCH /api/crm/companies/{id}` e de criação, e o **IP do servidor** na allowlist.
2. **Como criar uma empresa-cliente** no CRM: rota exata (`POST /api/companies`? `POST /api/crm/companies`? via lead + `leads/{id}/convert`?), **campos obrigatórios** (hoje enviamos `name`, `razaoSocial`, `cnpj`, `email`, `phone`, `crmStatus`) e o formato do **id devolvido**.
3. **`PATCH /api/crm/companies/{id}`**: confirmar que `{ "crmStatus": "ACTIVE|INACTIVE|CHURNED" }` basta, quais valores são aceitos e se há **transições proibidas** (ex.: CHURNED → ACTIVE).
4. **Efeitos colaterais** de mudar `crmStatus`: INACTIVE/CHURNED desativa portal, monitoramento, usuários, contratos ou cobranças no CRM? (Precisamos saber antes de ligar: cancelar um cliente aqui não pode derrubar serviço de rede lá sem querer.)
5. **Duplicidade por CNPJ**: o CRM recusa (409) ou cria duplicado? Existe **chave de idempotência**? (Hoje buscamos por CNPJ antes de criar.)
6. **Qual empresa emissora** (K3G Solutions / K3G Call) um cliente novo pertence no CRM, e como informar isso na criação (`companyRef`?).
7. **Ambiente de homologação** (`api-homol.k3gsolutions.com.br`) com token de teste, para validarmos o envio antes de produção.
8. **Quem mais altera a situação no CRM?** Depois do corte o Finance é a fonte: pedir à equipe que **não edite situação/cadastro** no CRM (ou nos avise por webhook) para não divergir.
9. Limites de taxa (rate limit) da API de escrita.
