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

## Validador de CPF/CNPJ
Ao digitar o documento no cadastro, o sistema confere os **dígitos verificadores** na hora: verde = válido (mostra o formato certo); vermelho = não confere. Quando o erro parece digitação (por exemplo, dois dígitos finais trocados), aparece a **sugestão** com um clique. O servidor confere de novo ao salvar. CNPJ alfanumérico também é aceito. Clientes que vêm do CRM continuam somente leitura aqui (a correção é no CRM); para o histórico da planilha use *Histórico → Corrigir CNPJ/CPF*.

## Editar o cliente (tudo na mesma caixa)
Abra **Clientes → o cliente**: a caixa **Editar** reúne, em abas, tudo o que é ajuste do cadastro:
- **Dados:** razão social, nome fantasia, CPF/CNPJ (com o validador) e situação.
- **Endereço:** CEP, logradouro, número, complemento, bairro, município, código IBGE e UF. É o endereço do cliente como tomador da nota fiscal.
- **Nota fiscal e boleto:** o **texto da nota fiscal** (a descrição do serviço que vai na NFS-e) e o **texto do boleto** (instruções que saem no boleto). Em branco, vale o padrão (descrição do contrato na nota; nenhuma instrução no boleto). Dá para usar os campos `{{cliente}}`, `{{empresa}}`, `{{valor}}`, `{{vencimento}}`, `{{competencia}}`, `{{descricao}}` e `{{emissao}}`; só texto simples, sem HTML. Na emissão (hoje simulada) esses textos e o endereço já seguem para o provedor.
- **Anotações:** o registro de observações do cliente (só de acréscimo: não dá para editar nem apagar).
- **Contatos:** quem recebe as cobranças (marque o contato financeiro).
**Cliente vindo do CRM:** a aba *Dados* mostra razão social, CNPJ e situação só para leitura (a sincronização os sobrescreveria; corrija no CRM). Endereço, textos, anotações e contatos são só daqui e **continuam editáveis**; a sincronização não os altera.
Quem pode editar: quem altera cadastros (diretoria, gerente, assistente). Cada alteração entra no registro de atividades (só os **nomes** dos campos, nunca o conteúdo).

