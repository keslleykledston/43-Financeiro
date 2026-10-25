# Revisão Codex — D3 histórico de despesas (staging + análise), 2026-10-25, somente leitura

Escopo: leitor da planilha, regras de sugestão, relatório, staging imutável (migração 0034), tela, CSV, script de operação.

**Resultado: 0 P0, 1 P1 (listado como P1 no corpo), 8 P2/P3. Tratados ou aceitos como abaixo.**

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P1 | `OPS_REPLACE` apagava a importação atual antes de gravar a nova (não atômico) | Corrigido: `importExpenses({ replace })` troca NA MESMA transação; arquivo igual (hash) responde "já importado" sem apagar; linha recusada pelo banco mantém a anterior; testes dos três casos |
| 2 | P2 | Gatilho não cobre `TRUNCATE` | **Aceito**, como no H1/E21: o `TRUNCATE ... CASCADE` é usado na limpeza dos testes de todo o projeto e exige dono da tabela; mitigação é operacional (backup antes de qualquer mudança; restore validado) |
| 3 | P2 | Limites de tamanho/largura só depois do parse | Parcial: limite de 60 colunas e de linhas verificado no script; parser para em 6.000 linhas; o arquivo é do próprio dono (10 MB já limitado antes de ler) |
| 4 | P2 | Linha podia violar índice único/CHECK e derrubar a importação sem diagnóstico | Corrigido: o parser não repete (aba, linha, bloco) e a falha do banco vira mensagem clara ("nada foi gravado e a importação anterior foi mantida"). `installmentOf` já exigia total ≥ 2 (teste cobre `1/1`) |
| 5 | P2 | `OPS_REPLACE` apagava antes de checar hash/permissões | Corrigido junto do #1: as duas permissões são checadas antes de qualquer escrita e o hash antes de apagar |
| 6 | P2 | Empresa do script escolhida por nome | Corrigido: recusa nome ausente ou repetido (ambíguo); RBAC segue obrigatório |
| 7 | P2 | Natureza "retirada"/"empresa" sugerida mesmo sem regra | **Aceito**: vem do próprio bloco da planilha (Casa × Empresa) e é só sugestão; sem regra, a categoria fica "A classificar" e a tela diz que é sugestão a conferir |
| 8 | P2 | `tithesPaidCents` parecia valor pago | Corrigido: renomeado para `tithesRecordedCents` (a aba de dízimos não tem coluna de pago) |
| 9 | P3 | Testes usam `TRUNCATE` nas tabelas de staging | Aceito (ver #2) |

Sem achado: isolamento por empresa (FK composta e filtros), autorização (importar `history.import`+`partners.read`; ler/exportar `partners.read`), nenhuma escrita fora do staging, CSV neutralizado em todas as colunas, telas sem HTML bruto, sem regex catastrófica.
