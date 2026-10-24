# Conta de e-mail (SMTP) para enviar cobranças

**Quem acessa:** só a diretoria cadastra. Os demais papéis não veem a seção.
**Onde:** menu **Integrações → E-mail (SMTP) — envio de cobranças**. Cada empresa (K3G Solutions, K3G Call) tem a sua conta.

> **Guardar a conta não liga o envio.** O e-mail real só sai com três travas ao mesmo tempo (veja *Envio real — canário*, abaixo). Hoje a chave do servidor está **desligada**: nada é enviado.

## O que preencher
- **Servidor SMTP:** o nome público do servidor (ex.: `smtp.k3gsolutions.com.br`). Não aceitamos endereço IP nem nomes internos, por segurança.
- **Porta e segurança:** 587 com STARTTLS (o mais comum), 465 com SSL/TLS direto, ou 2525/25 com STARTTLS. O sistema recusa combinações incoerentes (SSL só na 465).
- **E-mail remetente** e, se quiser, **nome do remetente** (ex.: *K3G Solutions — Financeiro*) e **responder para**.
- **Usuário e senha:** de preferência uma conta/senha de aplicativo **só do sistema**, não a senha pessoal de uma caixa.

## Como os dados são guardados
- Usuário e senha ficam **cifrados** e **nunca voltam** para a tela (nem para a diretoria). O servidor, a porta e o remetente aparecem para conferência.
- Para corrigir só o remetente (por exemplo), deixe usuário e senha **em branco**: os atuais são mantidos. Para trocar a senha, digite a nova.
- **Remover** apaga a conta guardada. Cada mudança entra no *Registro de atividades* (sem usuário, senha ou endereços).
- Se a chave do servidor (`K3G_CREDENTIALS_KEY`) for trocada, os segredos guardados deixam de abrir e precisam ser digitados de novo.

## Envio real — canário
O e-mail real é um **canário**: sai só para uma **lista autorizada** (de início, endereços internos), com limite diário. Só envia com as **três travas**:
1. A **chave do servidor** (`EMAIL_EXTERNAL_ENABLED`), ligada por quem opera o servidor.
2. Uma **autorização registrada** aqui (só diretoria): referência do documento escrito, quem pode receber (endereços; ou `@seudominio` para todo o domínio do remetente) e o limite diário. Registrar **não envia**. Para trocar, registre outra (a anterior é revogada e fica no histórico); *Revogar* desliga na hora.
3. A conta cadastrada acima.

Quando as travas estão ligadas, o topo do sistema mostra **E-MAIL REAL ATIVO (canário)**. Com a autorização ativa há o botão **Enviar teste** (um e-mail simples, sem dados de cliente, para um endereço da lista).
- **Mensagens → Processar fila** envia os e-mails da régua **só** para contatos que estão na lista; os demais ficam *Bloqueados* com o motivo. Boleto, nota e WhatsApp continuam simulados. A mensagem de cobrança **ainda não leva o boleto** (ele só existirá com a integração da Cora).
- Quando o servidor não confirma o envio (queda de conexão), o item vai para *Bloqueado* com "o e-mail pode ter sido enviado": o sistema **nunca reenvia sozinho** nesse caso. Confira nos enviados e, se preciso, reprograme.
- O registro de envios (em *Últimos envios reais*) guarda só a data, o tipo, o **domínio** do destinatário e o resultado, nunca o endereço. Mensagens já enviadas não podem ser apagadas nem alteradas.

## O que ainda falta para sair do canário
SPF/DKIM/DMARC do domínio, tratamento de e-mails devolvidos, o boleto dentro da mensagem e a sua autorização escrita para ampliar a lista. Veja o checklist em *Integrações → Portão da emissão real*.
