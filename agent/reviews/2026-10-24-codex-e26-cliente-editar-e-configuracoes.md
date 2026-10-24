# Revisão Codex — E26 (cliente: caixa Editar; textos nota/boleto; Configurações), 2026-10-24

Somente leitura. Sem P0/P1. Confirmou: permissão e tenant (crm.write, empresa do contexto, arquivado recusado), sync do CRM não toca nas colunas novas, auditoria só com nomes de campos, textos validados (sem HTML, campos permitidos, sem recursão), razão social na emissão, migração com colunas anuláveis, redirect de /configuracao só com company.manage, abas acessíveis.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | `getParty` de fornecedor poderia selecionar as colunas novas de `customers` e falhar em `vendors`. | NÃO É DEFEITO (verificado): o tipo trata as duas tabelas como iguais, mas em tempo de execução o Drizzle seleciona as colunas da tabela REAL passada (`tables(kind).main` = vendors). Os testes de fornecedor (CRUD, contatos, importação) rodam no sandbox e passam; `vendors` não ganhou colunas. Nenhuma mudança. |
