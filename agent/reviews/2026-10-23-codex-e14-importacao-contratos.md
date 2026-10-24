# Revisão Codex — E14 importação de contratos da planilha (2026-10-23)
Revisor: Codex (somente leitura). Commit revisado: b8e1f3d. Resultado: 0 P0, 1 P1, 3 P2 — todos tratados.

| # | Sev. | Achado | Tratamento |
|---|---|---|---|
| 1 | P1 | Criação manual de contrato não usava a trava da importação: importação concorrente podia gravar contrato duplicado para o mesmo cliente | `createContract` toma a trava advisory COMPARTILHADA `contract-import:<empresa>`; a importação toma a EXCLUSIVA. Não há índice único (um cliente pode ter vários contratos); a importação rechecha dentro da transação. Teste de corrida. |
| 2 | P2 | Aprovação em lote travava versões antes dos contratos (ordem oposta à de `proposeChange`) → deadlock possível | `decideImport` e `decideVersion` passam a travar contrato → versão (por id). Teste de corrida aprovar × editar. |
| 3 | P2 | Aba do mês mais recente vazia deixaria contratos sem fim de vigência | Mantido o padrão seguro (não encerra por aba vazia, pode ser modelo em branco); `emptyLaterTabs` e o resumo do script avisam "ATENÇÃO: abas posteriores sem linhas". Teste. |
| 4 | P2 | Leitor de XLSX sem limites de tamanho/complexidade | Script recusa >10 MB, >24 abas, >20.000 linhas/aba; roda só no container de ferramentas com `--max-old-space-size=512`; fora do fluxo web. |
