# Clientes e fornecedores

**Onde:** menu *Clientes*. Tudo é separado **por empresa**: o que você cadastra em uma empresa não aparece em outra.

## Cadastrar
1. *Novo* → escolha **Cliente** ou **Fornecedor**, informe razão social e **CPF ou CNPJ**.
2. O sistema confere os dígitos verificadores. Aceita o **CNPJ alfanumérico** (formato novo, ex.: `12.ABC.345/01DE-35`).
3. Não é possível ter dois cadastros **ativos** com o mesmo documento e tipo na mesma empresa.

## Contatos
Na página do cadastro, adicione contatos. Marque **Contato financeiro** para quem recebe cobranças.

## Buscar e filtrar
Busque por nome, nome fantasia ou documento (com ou sem pontuação). Use as abas *Todos / Clientes / Fornecedores*. A lista tem 20 itens por página.

## Arquivar
*Arquivar cadastro* some da lista ativa, mas **o histórico é mantido**. Veja em *Ver arquivados* e use *Restaurar*. Não há exclusão definitiva.

## Importar CSV
1. *Importar CSV* → envie o arquivo ou cole o conteúdo. Colunas: `tipo`, `razao_social`, `nome_fantasia`, `documento`, `email_financeiro`, `telefone` (separador `;` ou `,`; até 1000 linhas e 500 KB).
2. Clique em **Revisar**: nada é gravado. Cada linha aparece como *ok*, *duplicado* ou *erro*.
3. **Confirmar** grava só as linhas válidas. Importar o mesmo arquivo de novo não duplica.

## Exportar CSV
*Exportar CSV* baixa os cadastros ativos da empresa atual. Campos que começam com `=`, `+`, `-` ou `@` recebem um `'` na frente para não virarem fórmulas na planilha.

## Quem pode o quê
| Papel | Ver | Cadastrar/editar/importar | Exportar |
|---|---|---|---|
| Diretoria, Gerente | ✔ | ✔ | ✔ |
| Assistente | ✔ | ✔ | — |
| Contabilidade | ✔ | — | ✔ |
| Admin técnico | — | — | — |
