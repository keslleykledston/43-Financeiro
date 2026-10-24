# Revisão Codex — H1 (histórico da planilha: staging + divergências), 2026-10-24

Somente leitura. Confirmou: isolamento por empresa (relatório, desfazer, CSV), FK composta, dinheiro em numeric/centavos, CSV protegido, sem e-mail/contato no staging, auditoria só com ids/contagens.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P1 | Linha paga sem líquido entrava no "recebido" pelo valor da cobrança (caixa inflado). | CORRIGIDO: recebido = só o líquido informado; pagos sem líquido aparecem à parte como **estimativa** (linhas e valor), fora dos totais de recebido. Teste. |
| 2 | P1 | `amountOf` somava bruto+plano+excedente em toda linha (frágil; sem o bloco). | CORRIGIDO: o bloco e o valor da cobrança (Solutions = bruto; Call = plano + excedente) são guardados na importação (`block`, `amount`); o relatório não recalcula. Teste. |
| 3 | P2 | Trigger bloqueava só UPDATE; DELETE direto apagava o histórico sem auditoria. | CORRIGIDO: DELETE só passa dentro do fluxo "Desfazer importação" (variável de sessão local à transação); resto é recusado pelo banco. Teste. |
| 4 | P2 | Duas importações simultâneas do mesmo arquivo: a segunda falhava no UNIQUE. | CORRIGIDO: captura o 23505 e responde "já importado". Teste. |
| 5 | P2 | Data textual inexistente (31/02) virava março sem sinalizar. | CORRIGIDO: `isoDateOf` valida a data real; vira nula (divergência "sem vencimento"). Teste. |
