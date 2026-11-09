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

## Certificado digital A1 (NFS-e Padrão Nacional)
*Integrações → Certificado digital A1 — NFS-e.* Só a **diretoria** importa. Serve para assinar a nota fiscal de serviço da empresa; **importar não emite nada**.

**Como importar:** escolha o arquivo **.pfx / .p12** do certificado **e-CNPJ A1** da empresa e digite a senha que a certificadora definiu. O sistema confere:
- se a senha está certa e o arquivo está inteiro (certificado + chave privada juntos);
- se **não está vencido**;
- se o **CNPJ do certificado é o da empresa selecionada** (cadastre o CNPJ em *Configurações → Empresa* antes).

**Segurança:** o arquivo e a senha trafegam só pela conexão segura (HTTPS), são conferidos no servidor, o certificado e a chave ficam **cifrados** e **a senha é descartada** (não fica guardada em lugar nenhum). Nada disso volta para a tela: você vê só o titular, o CNPJ, a validade e a impressão digital. Cada importação e remoção fica no registro de atividades, sem segredo.

**Depois de importar:**
- **Conferir integridade** reabre o que está guardado e confirma que a chave combina com o certificado e que não venceu (não envia nada para fora).
- **Importar outro** substitui o atual e **apaga** o anterior; **Remover** apaga certificado e chave. Fica só um histórico público (validade e impressão digital).
- Avisamos quando faltam **30 dias ou menos** para vencer.

**Não serve:** certificado A3 (cartão/token), e-CPF (pessoa física) ou de outro CNPJ.

---
## Corte do CRM: o K3G Finance passa a ser a fonte dos clientes
Quando a diretoria decide, o K3G Finance deixa de **ler** o CRM e passa a ser a **fonte da verdade** (cadastro, contratos e situação do cliente). Daí em diante o K3G Finance **escreve no CRM**: ajusta a situação (ativo, suspenso, cancelado) e cria o cliente novo.

**Fazer o corte** (*Integrações → Corte do CRM*, só diretoria): confira a lista (conflitos em aberto = 0; última sincronização recente), digite **CORTE** e confirme. Se a última sincronização tem mais de 24 horas, sincronize de novo antes (ou marque que aceita perder o que mudou no CRM). **Não tem volta.** Depois do corte: todos os cadastros ficam editáveis aqui, a sincronização com o CRM deixa de existir e a origem não volta a «CRM».

**Envio ao CRM** (*Integrações → Envio ao CRM*): toda troca de situação e todo cliente novo (cadastro ou CSV) entram numa **fila**; um robô envia ao CRM a cada minuto. Se o CRM estiver fora do ar, ou o acesso de escrita ainda não tiver sido liberado pela equipe do CRM, **nada se perde**: fica «na fila» e sai depois, sozinho. O que falhar aparece com o motivo e tem o botão **Tentar de novo**. «Enviar ao CRM os N clientes sem cadastro lá» coloca na fila quem ainda não existe no CRM. Na ficha do cliente aparece o estado do último envio.

**Situação pelos contratos:** na ficha do cliente, quando a situação dos contratos pede outra situação (ex.: todos os contratos encerrados → «Cancelado»), aparece a sugestão com o botão **Aplicar**. A mudança também vai ao CRM. Suspenso e cancelado param de gerar cobrança; voltar a **Ativo** exige gerente ou diretoria.

