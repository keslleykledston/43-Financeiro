# Importar contratos da planilha

**Quem acessa:** quem cria contratos (assistente, gerente, diretoria) importa; gerente e diretoria aprovam. Contabilidade só consulta.
**Onde:** Contratos → **Importar**.

## Para que serve
Trazer de uma vez os contratos que hoje vivem na planilha de boletos, sem digitar um por um. Cada linha do arquivo vira um contrato **em rascunho**; nada vigora nem gera cobrança até outra pessoa aprovar.

## Passo a passo
1. **Gerar o CSV.** O conversor roda no servidor (fora do site) e transforma a planilha `.xlsx` em dois arquivos: um da K3G Solutions e um da K3G Call. Regras do conversor:
   - vale o **valor do mês mais recente** do cliente (a Call usa o *Plano*; o *Excedente* não entra no contrato, ele é lançado todo mês em Faturamento → Ajustes);
   - o vencimento é o **dia mais comum** do cliente na planilha;
   - a vigência começa no primeiro mês em que o cliente aparece; quem **sumiu das últimas abas** recebe fim no último mês cobrado;
   - a marca **comissão Medina** vem da coluna *Observações*.
2. Em **Contratos → Importar**, envie o CSV (ou cole o conteúdo) e toque em **Revisar**. Nada é gravado.
3. Leia a prévia:
   - **pronto**: o cliente já existe e vai ganhar o contrato;
   - **cliente novo**: só acontece em empresa com cadastro **local** (K3G Call); o cliente é criado junto, com o e-mail e o contato financeiro da planilha;
   - **cliente ausente**: a empresa usa o CRM (K3G Solutions) e o CNPJ não está lá. Cadastre no CRM, sincronize e importe de novo;
   - **já tem contrato** / **repetido**: ignorados, então reimportar o mesmo arquivo é seguro;
   - **erro**: CNPJ ausente ou inválido, valor, dia (1–31) ou data inválidos. Corrija no arquivo.
4. **Confirmar**. Abre o *lote*, com todos os contratos em rascunho.
5. **Aprovar o lote** (gerente ou diretoria, **outra pessoa** que não importou; a diretoria pode aprovar o que ela mesma importou). Aprovar ativa todos de uma vez. **Rejeitar** mantém os rascunhos com o histórico.

## Colunas do CSV
Obrigatórias: `razao_social`, `documento`, `servico`, `valor_mensal` (ex.: 2.500,00), `dia_vencimento`, `inicio` (aaaa-mm-dd). Opcionais: `fim`, `email_financeiro`, `contato`, `parceiro_comissao`. Até 1000 linhas e 500 KB. O modelo está na própria tela.

## O que não fazer
- Não importe sem conferir a prévia, principalmente CNPJs inválidos e valores.
- Cliente **suspenso ou cancelado** recebe o contrato, mas ele não gera cobrança enquanto o cliente não voltar a ser ativo.
- O arquivo contém dados de clientes: não envie por e-mail nem guarde fora de pasta privada.

_Última atualização: 2026-10-23._
