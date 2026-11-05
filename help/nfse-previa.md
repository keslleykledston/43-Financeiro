# Prévia da NFS-e (Padrão Nacional)

> **Só uma prévia.** Esta tela não emite nota, não assina e não fala com a prefeitura. Ela mostra se a empresa e o cliente têm os dados necessários e como a nota ficaria.

## Onde fica
*Faturamento → Lotes →* abra o lote → na cobrança de cliente que **emite nota fiscal** (ou exige boleto + NF), o link **Prévia da NFS-e**.

## O que a tela mostra
- **Resumo:** prestador, cliente (tomador), valor e a descrição que iria na nota (o texto da nota do cliente, ou a descrição do contrato).
- **O que falta:** lista em português do que impede montar a nota (ex.: regime tributário, código de tributação nacional, código IBGE do município, CPF/CNPJ do cliente).
- **Arquivo da DPS (XML):** quando os dados estão completos, o arquivo no formato oficial da NFS-e Padrão Nacional (versão 1.01), em ambiente de **homologação**. Dá para baixar, mas ele **não vale como nota**.

## Onde corrigir
- Empresa (regime, inscrição municipal, alíquota, município, **código de tributação nacional**): *Configurações → Empresa*. O contador informa o código de 6 dígitos (item, subitem e desdobro da LC 116; ex.: 01.07.01).
- Cliente (CPF/CNPJ, razão social, endereço, texto da nota): *Clientes → Editar*.

## Importante
- Endereço do cliente incompleto não impede a prévia: a nota seguiria sem o endereço do tomador (aviso amarelo).
- A emissão real exige o certificado digital A1 da empresa, teste em ambiente de homologação da Receita e autorização escrita da diretoria. Enquanto isso, a nota continua sendo emitida fora e anexada à cobrança.
