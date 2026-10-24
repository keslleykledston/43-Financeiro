# Alertas de contratos

**Quem acessa:** todos que veem contratos (assistente, gerente, diretoria, contabilidade). Para agir, quem altera contratos.
**Onde:** Contratos → aviso amarelo no topo da lista → **Ver alertas** (ou direto em *Contratos → Alertas*).

## Regra de base
Todo contrato vale **12 meses** e **renova sozinho** por mais 12 se o cliente não se manifestar. Contrato **sem data final** é um contrato que segue renovando. A data final só é preenchida quando o cliente (ou a K3G) encerra.

## Para que serve
Avisar a tempo das datas que custam dinheiro quando passam batido: a **renovação automática** (a última chance do cliente se manifestar e o momento natural do **reajuste**) e as **datas finais informadas**. A tela só avisa; nada é alterado ou enviado sozinho.

## O que aparece
| Alerta | Quando |
|---|---|
| **Fim informado já passou** | a data final passou e o contrato continua ativo ou suspenso. Ele **já não gera cobrança**: encerre o contrato ou, se ele segue renovando, apague a data final |
| **Reajuste em atraso** | passaram 12 meses desde o início (ou desde a última aprovação que mudou o valor) e não há novo valor aprovado |
| **Fim informado se aproxima** | a data final cai na janela escolhida (30, 60 ou 90 dias; o padrão é 60): depois dela o contrato deixa de renovar e de cobrar |
| **Renovação automática** | o contrato completa 12, 24, 36… meses dentro da janela. Quando o reajuste cai no mesmo dia, o aviso diz isso |
| **Reajuste se aproxima** | os 12 meses desde a última mudança de valor se completam na janela e não coincidem com a renovação |

Contratos em rascunho ou encerrados não geram alerta. Contrato com data final antes da renovação não mostra renovação nem reajuste. Contrato **suspenso** continua mostrando a data final e a renovação (a suspensão não encerra o contrato), mas não o reajuste.

## Como tratar cada alerta
1. Toque na linha para abrir o contrato.
2. **Reajuste:** proponha o novo valor em *Propor alteração*. A alteração vai para aprovação de outra pessoa e, aprovada, o contador de 12 meses recomeça sozinho.
3. **Cliente não vai renovar:** proponha a data final (ela vai para aprovação).
4. **Fim informado que passou, mas o cliente continua:** proponha apagar a data final.

## Limites a conhecer
- A data de início dos contratos importados da planilha é o **primeiro mês em que o cliente aparece nela**, não a data da assinatura. Se o contrato real é mais antigo ou mais novo, a renovação e o reajuste previstos saem errados: corrija o início numa alteração de contrato.
- Contratos importados cujo cliente **sumiu das últimas abas** vieram com data final; confira se o cliente realmente saiu.
- Ainda não existe o índice de reajuste (IPCA, IGP-M) nem o percentual; o sistema só diz *quando*, não *quanto*.
- A contagem de um novo reajuste recomeça na data da **aprovação** da alteração.
