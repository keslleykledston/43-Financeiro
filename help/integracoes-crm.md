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

---
## Dois cenários: Local ou CRM (por empresa)
Em *Integrações → Origem dos clientes* a diretoria escolhe, **para cada empresa**:

| | **Local** (padrão) | **CRM** |
|---|---|---|
| Clientes | cadastrados aqui ou por CSV | vêm do CRM, **somente leitura** |
| Fornecedores | locais | locais |
| Novo cliente / CSV de clientes | permitido | **bloqueado** |
| Sincronização | desligada | disponível (com prévia e confirmação) |
| Cadastros que vieram do CRM | editáveis | somente leitura |

- Voltar para **Local** libera a edição dos cadastros já importados. Ao voltar para **CRM**, o CRM volta a sobrescrever os campos dos cadastros vinculados.
- As duas empresas podem usar modos diferentes.
- Contatos adicionais (locais) podem ser criados nos dois modos.
- A troca fica registrada na auditoria.

---
## Situação do cliente (ativo, suspenso, cancelado)
- Só clientes **ativos** são faturáveis. **Suspensos** e **cancelados continuam cadastrados** (podem ter dívidas antigas a receber), mas **não geram nova cobrança**.
- Na importação do K3G CRM: `ACTIVE` → ativo · `INACTIVE` → suspenso · `CHURNED` → cancelado. Registros `PROSPECT` **não são clientes** e não entram.
- Na lista de clientes há um filtro por situação e um selo para suspensos e cancelados.
- No modo **Local** você escolhe a situação no cadastro (e na coluna opcional `situacao` do CSV). No modo **CRM** ela vem do CRM e fica somente leitura.
- **Contratos** não vêm do CRM: são cadastrados aqui (próxima fase).

## Cora (boletos)
Credenciais e o que a integração com a Cora faz: veja `cora-boletos.md`.

## Outras seções desta tela
- **Cora — boletos:** veja o artigo *Cora: boletos (credenciais e escopo)* (`cora-boletos`).
- **E-mail (SMTP):** conta usada para enviar cobranças; veja o artigo *Conta de e-mail (SMTP)* (`conta-de-email`). Guardar a conta não liga o envio.
