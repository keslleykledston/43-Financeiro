# Central de Ajuda K3G Finance

Esta pasta precisa acompanhar o frontend. Cada entrega que altera a interface cria/atualiza um artigo com:
1. Objetivo da tela;
2. Quem pode acessar;
3. Passo a passo com termos leigos;
4. Significado de campos e status;
5. Erros comuns, soluções e 'o que não fazer';
6. Última atualização e screenshot ilustrativa **sem dados reais**.

Artigos iniciais: `primeiro-acesso.md`, `dashboard.md`. Depois: clientes, contratos, lotes, templates, conciliação, usuários/permissões, dúvidas frequentes.

A central de ajuda deve aparecer em rota autenticada `/ajuda` e em contexto `?` em cada tela relevante. Não publicar dados sensíveis nem caminhos internos de servidor.

## Como a central funciona (implementada)
Os artigos desta pasta são exibidos em `/ajuda` (lista) e `/ajuda/<nome-do-arquivo>`; o botão **?** do cabeçalho abre o artigo da tela atual (mapa em `src/modules/help/routes.ts`: ao criar uma tela nova, acrescente a linha). O `README.md` não aparece. Formato aceito: títulos `#`–`###`, listas, tabelas, citações `>`, **negrito**, *itálico*, `código` e links `outro-artigo.md`; HTML bruto é mostrado como texto. Linhas `**Quem acessa:**` e `**Onde:**` logo abaixo do título alimentam a lista.
