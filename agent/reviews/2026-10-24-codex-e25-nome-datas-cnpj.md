# Revisão Codex — nome fantasia, datas americanas e correção de CNPJ, 2026-10-24

Somente leitura. Sem P0/P1. Confirmou: boleto/NFS-e seguem com a razão social; busca por razão social preservada; sem PII no audit; isolamento por empresa; sem bypass 11×14; sem alteração do staging nem de cadastros; sem XSS.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | O padrão do nome fantasia só cobria a raiz de 8 dígitos. | CORRIGIDO: aceita CNPJ completo (com/sem pontuação) e "S.A."; testes. |
| 2 | P2 | A correção de data podia trocar uma data certa (pagamento futuro virar janeiro). | CORRIGIDO: o pagamento só é trocado na MESMA linha em que o vencimento foi corrigido (evidência do Excel lendo MM/DD); sozinho, nunca. Todas as correções ficam listadas ("data invertida"). Teste. |
| 3 | P2 | A correção por nome podia atribuir documento a clientes de nome parecido. | CORRIGIDO: vale só nas linhas SEM documento válido (nunca sobrescreve CNPJ válido); sugestão do cadastro ignora nomes ambíguos. Teste. |
| 4 | P2 | Duas pessoas corrigindo ao mesmo tempo: a última vence sem aviso. | CORRIGIDO: trava por empresa + conferência do valor que a pessoa viu ("expected"); conflito pede recarregar. Teste. |
