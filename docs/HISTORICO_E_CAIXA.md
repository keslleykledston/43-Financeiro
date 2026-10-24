# Histórico de clientes e dados de caixa a partir da planilha de boletos

Análise de 2026-10-24 sobre `Boletos__2026.xlsx` (10 abas, JAN–OUT). Só leitura, números agregados; nada foi importado. A carga histórica continua dependendo de **nova autorização escrita**.

## 1. O que a planilha realmente contém (fatos medidos)
| Fato | Valor |
|---|---|
| Linhas de cobrança | 655 (Solutions 499, Call 156), 95 clientes distintos (chave por CNPJ) |
| Crescimento | 58 linhas em janeiro → 87 em outubro; base mensal ≈ R$ 112 mil → R$ 152 mil |
| **A aba é o mês do VENCIMENTO**, não da competência | 634 de 655 vencimentos caem no mês da aba. A competência do serviço é o mês anterior (regra M / M+1) |
| Datas de pagamento (`DATA PG`) | preenchidas em ~90% das linhas (582 com vencimento e pagamento): **dá para reconstruir o caixa realizado por mês** |
| Prazo de pagamento | mediana 1 dia após o vencimento; 25% pagam no vencimento ou antes; 75% até 5 dias depois |
| `LÍQUIDO` ≠ valor + excedente | 87 linhas: 84 a maior (juros/multa por atraso), 3 a menor (desconto/retenção). Diferença típica R$ 27. Casa com o modelo de baixa que já existe (E07c: juros e desconto) |
| Excedente | só no bloco Call (R$ 0,4 a 1,2 mil/mês) |
| Dinâmica | 54 clientes em janeiro; entraram 2, 1, 1, 1, 3, 9, 8, 5, 11 nos meses seguintes; 14 saíram; 1 sumiu e voltou; 26 mudaram de valor; 18 mudaram o dia de vencimento; 5 casos com duas linhas no mesmo mês |
| Em aberto (vencido sem `DATA PG`) | R$ 23,4 mil em outubro, R$ 17 mil em setembro, R$ 10,2 mil em agosto; resíduos pequenos nos meses antigos (inadimplência histórica real) |
| Caixa realizado por mês de pagamento (líquido) | jan R$ 94 mil · fev 102 · mar 104 · abr 113 · mai 112 · jun 118 · jul 121 · ago 114 · set 141 · out 109 (parcial) |

## 2. Problemas de qualidade que a carga precisa tratar (não esconder)
- **21 vencimentos fora do mês da aba** (ex.: aba JAN com data de maio/outubro): provável data copiada errada. Regra: o mês da aba manda; a data fora do mês vai para uma lista de revisão.
- **13 pagamentos a mais de 120 dias do vencimento**: ou data errada ou inadimplência longa; revisão.
- **9 clientes sem CNPJ ou com CNPJ inválido** e **19 fora do CRM** (já listados em arquivo privado): sem documento não há chave confiável.
- **Mesmo cliente duas vezes no mesmo mês** (5 casos): pode ser cobrança extra ou digitação duplicada.
- Início de vigência dos contratos hoje = primeira aba em que o cliente aparece (aproximação).

## 3. Opções avaliadas
**A. Manter a planilha como está e só consultá-la.** Barato, mas não alimenta faturamento, caixa nem conciliação, e repete o trabalho manual todo mês.

**B. Tabela de arquivo só de leitura (staging) + relatórios.** Seguro e rápido; preserva cada linha como veio. Sozinho, não dá continuidade ao painel, às contas a receber nem à conciliação (os números ficam fora dos fluxos reais).

**C. Carregar como cobranças e baixas de verdade (modelo operacional).** É o que dá continuidade total (painel "recebido no mês", inadimplência, conciliação). Risco: encher lotes/aprovações/régua/emissão com dados históricos e quebrar as travas (um lote por data, emissão, mensagens).

**D (recomendada): em camadas.**
1. **H1 — Staging imutável** `legacy_billing_rows` (empresa, aba, linha, cliente por documento, valores, datas, observação, hash do arquivo) + **relatório de divergências** (as listas da seção 2). Importação idempotente por (empresa, hash do arquivo, aba, linha) e auditada. *Sem tocar em cobranças nem contratos.*
2. **H2 — Linha do tempo do cliente e do contrato** (eventos: entrou, mudou valor, mudou vencimento, suspenso, voltou, saiu) **derivada** do staging, com data de efeito. Alimenta os **aditivos** (item 4) e corrige o início de vigência dos contratos. Cada evento fica marcado como "inferido da planilha" até alguém confirmar.
3. **H3 — Cobranças e baixas históricas** (`charges`/`payments` com `origin = 'historico'`, lote próprio "histórico" já aprovado e **fora** da emissão e da régua), somente para meses **fechados** e após revisão das divergências. Reaproveita juros/desconto (E07c). Os totais por mês precisam bater com a planilha (critério de aceite) e a carga é desfazível por lote.
4. **H4 — Caixa**: visão de recebimentos por data de pagamento (o que a planilha já permite) + comparação com o extrato.

Por que D: preserva a evidência original (B), dá continuidade ao dia a dia (C) sem contaminar as regras de emissão/régua e mantém reversibilidade e conferência por totais.

## 4. Caixa: o que dá para coletar e o que falta
- **Entradas (recebimentos):** já saem da planilha (H3/H4) e, daqui para frente, das baixas (E07) e da conciliação.
- **Saídas (despesas):** a planilha não tem. O módulo de contas a pagar existe (E11), mas está vazio. **Precisamos de uma fonte**: planilha/relatório de despesas de 2026 ou o histórico do banco.
- **Extrato bancário:** pela decisão de segurança (ADR-017) a API da Cora **não** lê saldo nem extrato. O caminho é **importar o extrato em CSV/OFX** que o próprio banco exporta (a E08 já importa CSV genérico; falta uma **amostra real do extrato da Cora** para o formato definitivo). Com o extrato de 2026, conferimos cada `DATA PG` contra o crédito real: é a melhor validação do caixa.
- **Saldo/caixa projetado:** com recebíveis (vencimentos futuros dos contratos ativos) + contas a pagar agendadas + saldo inicial informado pela diretoria.

## 5. Edição por administrador, aditivos, comentários e ajustes (pedido de 2026-10-24)
Estado hoje: clientes **locais** já são editáveis (nome, documento, situação); clientes vindos do **CRM** são somente leitura (corrigir no CRM). Contratos já têm alteração por versão, e **a diretoria pode aprovar a própria alteração**. Faltam: aditivo com data de efeito e tipo, comentários, dados cadastrais da própria empresa e uma visão clara de "ajuste de valor".

Proposta (E21, pequena e sem tocar em cobrança passada):
- **Aditivo** = versão de contrato com **tipo** (reajuste, alteração de valor, prorrogação, rescisão, outros), **data de efeito**, **referência/descrição do documento** e motivo obrigatório; aprovação pelo fluxo atual (a diretoria aprova). Fica no histórico do contrato; as cobranças futuras usam o valor vigente na competência.
- **Comentários**: notas **só de acréscimo** (autor, data, texto) em contrato e em cliente, sem edição nem exclusão, visíveis a quem lê o cadastro; entram no registro de atividades (sem o texto).
- **Ajuste de valores**: dois caminhos já previstos — valor do contrato (por aditivo, vale daqui para frente) e ajuste pontual da competência (excedente, acréscimo, desconto — E05c).
- **Dados da empresa** (razão social, nome fantasia, CNPJ, e-mail financeiro, endereço): edição pela diretoria, auditada. A tabela `companies` hoje só tem nome e CNPJ.
- **Cliente do CRM**: continua somente leitura; só comentários locais. Se o dado do CRM estiver errado, corrige-se no CRM e sincroniza.

## 6. Decisões que preciso de você
1. Aprovar a abordagem **D** (H1 → H2 → H3 → H4), começando por **H1 (staging + relatório de divergências)**, que não altera nenhum cadastro.
2. Autorização escrita para a **carga histórica** quando chegarmos à H3 (continua exigida).
3. Fonte das **despesas** de 2026 e **amostra do extrato Cora** (CSV/OFX, pode ser com valores trocados).
4. Para os 21 vencimentos fora do mês: aceitar a regra "o mês da aba manda"?
