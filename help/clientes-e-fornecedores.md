# Clientes e fornecedores

**Onde:** menu *Clientes*. Tudo é separado **por empresa**: o que você cadastra em uma empresa não aparece em outra.

## Cadastrar
1. *Novo* → escolha **Cliente** ou **Fornecedor**, informe razão social e **CPF ou CNPJ**.
2. O sistema confere os dígitos verificadores. Aceita o **CNPJ alfanumérico** (formato novo, ex.: `12.ABC.345/01DE-35`).
3. Não é possível ter dois cadastros **ativos** com o mesmo documento e tipo na mesma empresa.

## Contatos
Na página do cadastro, adicione contatos. Marque **Contato financeiro** para quem recebe cobranças.

## Buscar e filtrar
Busque por nome, nome fantasia ou documento (com ou sem pontuação). Por padrão a lista mostra **só os ativos** (faturáveis). Para ver suspensos, cancelados ou tudo, troque o filtro **Situação** (a última opção é «Todas as situações»); se a busca não achar um cliente, a tela avisa e oferece «Ver todas as situações». Use as abas *Todos / Clientes / Fornecedores*. A lista tem 20 itens por página.

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
Ao digitar o documento no cadastro, o sistema confere os **dígitos verificadores** na hora: verde = válido (mostra o formato certo); vermelho = não confere. Quando o erro parece digitação (por exemplo, dois dígitos finais trocados), aparece a **sugestão** com um clique. O servidor confere de novo ao salvar. CNPJ alfanumérico também é aceito. Clientes que vêm do CRM continuam somente leitura aqui para razão social e documento (a correção é no CRM); para o histórico da planilha use *Histórico → Corrigir CNPJ/CPF*.

## Editar o cliente
Abra **Clientes → o cliente**. A caixa **Cadastro** tem três abas: **Dados**, **Nota fiscal e boleto** (os textos) e **Anotações**.

A aba **Dados** mostra tudo junto, para ler de uma vez:
- **Identificação:** razão social, nome fantasia, CPF/CNPJ e situação.
- **Nome aparente e emissão:** veja abaixo.
- **Endereço:** CEP, logradouro, número, complemento, bairro, município, código IBGE e UF. É o endereço do cliente como tomador da nota fiscal.
- **Contatos:** quem recebe as cobranças (marque o contato financeiro).

Para mudar qualquer coisa, clique em **Editar** (canto da aba Dados). Os formulários aparecem; ao terminar, clique em **Concluir edição**.

### Nome aparente
Como o cliente é conhecido no dia a dia, quando isso é diferente do nome fantasia. Ele **aparece no lugar do nome em todas as telas e na busca**, e ajuda a achar o cliente. **Boleto e nota fiscal continuam saindo com a razão social, e os e-mails e WhatsApp ao cliente não usam o nome aparente** (ele é interno, só para a equipe). Em branco, vale a regra de sempre (o fantasia, quando a razão social é só o número do CNPJ).

### O que este cliente recebe
- **Emite boleto:** desmarcado, o cliente **fica de fora da emissão de boletos** (por exemplo, paga por outro meio). Ele não entra no «Solicitar boletos» do lote; se for desmarcado depois de solicitado, a emissão não sai.
- **Emite nota fiscal:** marcado, a nota fiscal é **esperada** para esse cliente: o lote mostra onde anexar o PDF e avisa quando falta. Quando o contrato exige «boleto + NF», o e-mail continua esperando pela nota; o simples «emite nota fiscal» **não** segura o e-mail.
Quem tem contrato com «NF junto do boleto» já vem marcado como «emite nota fiscal».

**Cliente vindo do CRM:** razão social e CNPJ ficam só para leitura: a sincronização os sobrescreveria, corrija no CRM. A **situação** (Ativo, Suspenso, Cancelado) você define aqui: em *Editar → Situação → «Situação neste sistema»*. Ao salvar, a escolha **trava** a situação deste cliente e o CRM deixa de trocá-la (a tela mostra «definida aqui»). Para voltar a seguir o CRM, escolha «Seguir o CRM» na mesma caixa: a próxima sincronização decide. Voltar a **Ativo** (voltar a faturar) exige gerente ou diretoria, e toda troca fica no histórico. Suspenso e cancelado não geram nova cobrança. Nome aparente, emissão, endereço, textos, anotações e contatos são só daqui e podem ser editados.
