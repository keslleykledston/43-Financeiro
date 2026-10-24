# Dados da empresa, contabilidade, aditivos e comentários

**Quem acessa:** os **dados da empresa** só a diretoria edita. **Aditivos**: quem altera contratos propõe, gerente/diretoria aprovam (a diretoria também pode aprovar na hora). **Comentários**: quem altera contratos ou cadastros escreve; quem lê o cadastro lê.
**Onde:** Ajustes → *Dados da empresa*; dentro de cada contrato (*Aditivo ou ajuste de valor* e *Comentários*); dentro de cada cliente (*Comentários*).

## Dados da empresa (K3G Solutions / K3G Call)
1. Ajustes → **Dados da empresa**.
2. Edite nome, razão social, CNPJ, e-mail do financeiro e endereço → *Salvar*.
3. O CNPJ é conferido pelos dígitos verificadores e não pode repetir em outra empresa. Trocar o CNPJ **não** altera nada na Cora: confira se a conta cadastrada é a desse CNPJ.
4. Cada alteração entra no *Registro de atividades* (só diz **quais campos** mudaram, não os valores).

## Contabilidade e dados fiscais (contador, NFS-e)
Na mesma tela, bloco **Contabilidade e dados fiscais** (só diretoria):
- **Contador ou escritório:** nome, CPF/CNPJ (conferido pelos dígitos), CRC, pessoa de contato, telefone, e-mail e observações (prazo de fechamento, quem emite as notas).
- **Dados fiscais da empresa para a nota (NFS-e):** regime tributário, inscrição municipal, CNAE principal (7 dígitos), código do serviço (LC 116, ex.: 1.07), alíquota do ISS, ISS retido, endereço completo, CEP, município, código IBGE (Manaus: 1302603) e UF.
- No topo do bloco o sistema mostra **o que ainda falta** para a NFS-e e para a contabilidade. Mande essa lista ao contador: quando ela some, a empresa está pronta, do lado dos dados.
- **Guardar não emite nota nem fala com a prefeitura.** A emissão real é outra fase e depende de autorização.
- Não guardamos senha de portal de prefeitura. Se a NFS-e exigir certificado digital da empresa, entra numa fase própria, no cofre.

## Aditivo e ajuste de valor em contrato
Abra o contrato → **Aditivo ou ajuste de valor**:
- **Tipo**: alteração, reajuste (muda o valor), ajuste de valor, prorrogação (muda o fim) ou outros. Reajuste/ajuste de valor exigem um valor diferente do vigente; prorrogação exige outro fim de vigência.
- **Vale a partir de** (opcional): a data em que o aditivo passou a valer. **Não pode ser futura**: registre quando ele entrar em vigor. Se informada, o alerta de reajuste de 12 meses conta a partir dela.
- **Referência do documento** (opcional): onde está o aditivo assinado (ex.: "2º aditivo, pasta Contratos/2026").
- **Motivo**: o que mudou e por quê.
- A mudança **só vale depois de aprovada**. Quem pediu não aprova a própria alteração, **exceto a diretoria**, que pode marcar *Aprovar agora*: o aditivo entra em vigor e fica gravado quem pediu e quem aprovou.
- Cobranças **já geradas não mudam**. As próximas prévias de lote usam os novos termos. Para um desconto ou acréscimo só de um mês (excedente etc.), use *Faturamento → Ajustes da competência*.
- Tudo aparece no *Histórico de versões* do contrato, com tipo, data de efeito e referência.

## Comentários
- Em contratos e clientes, bloco **Comentários**: escreva o que combinou com o cliente, por quê aceitou um desconto, etc.
- **Só de acréscimo**: depois de salvo, ninguém edita nem apaga (nem pelo sistema). Se errou, escreva outro comentário corrigindo.
- O texto fica no cadastro, **não** no registro de atividades (lá só aparece que um comentário foi feito).
- Clientes que vêm do CRM continuam **somente leitura**, mas aceitam comentários daqui.

## Limites
- Dados de **clientes do CRM** (nome, CNPJ) se corrigem no CRM e sincronizam; aqui só comentários.
- Aditivo com data futura (agendado) ainda não existe.
