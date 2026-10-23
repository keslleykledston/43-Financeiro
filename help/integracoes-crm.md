# Integração com o CRM (clientes e contratos)

**Onde:** menu *Integrações*. Só a **diretoria** ativa e sincroniza.

## Como funciona
- O **CRM é a fonte de verdade**. O K3G Finance só **lê** o CRM; nunca grava nele.
- Clientes vindos do CRM aparecem com o selo **CRM** e ficam **somente leitura** (para alterar ou arquivar, edite no CRM). Contatos adicionais locais são permitidos.
- Cadastro manual e importação por CSV continuam existindo, marcados com a origem.

## Sincronizar (sempre com prévia)
1. *Ativar* a integração nesta empresa e, se o CRM atende as duas empresas, informar a **identificação desta empresa no CRM**.
2. *Revisar sincronização*: o sistema consulta o CRM e mostra o que **mudaria** (novos, alterados, a arquivar, a restaurar, conflitos). **Nada é gravado.**
3. *Confirmar e aplicar*: o servidor refaz a consulta e aplica. Repetir não duplica nada.

## Conflitos
Quando o CRM traz um cliente com o **mesmo documento** de um cadastro local, ele **não sobrescreve** nada: vai para a fila de conflitos.
- **Vincular ao cadastro existente:** o cadastro local passa a ser o do CRM (e a ser sincronizado).
- **Ignorar:** mantém separado e não volta a avisar.

## Inativos
Cliente inativo no CRM é **arquivado** (nunca apagado). Se voltar a ficar ativo, é restaurado.

## Se o CRM estiver fora do ar
A sincronização mostra o erro e **não altera nada**. O resto do sistema continua funcionando.

## Segurança
Chave geral do servidor desligada por padrão. Credenciais ficam no servidor (não no banco nem no Git), somente leitura. Registros de auditoria guardam apenas contagens, sem dados pessoais.
