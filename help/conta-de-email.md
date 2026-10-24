# Conta de e-mail (SMTP) para enviar cobranças

**Quem acessa:** só a diretoria cadastra. Os demais papéis não veem a seção.
**Onde:** menu **Integrações → E-mail (SMTP) — envio de cobranças**. Cada empresa (K3G Solutions, K3G Call) tem a sua conta.

> **Guardar a conta não liga o envio.** Nenhum e-mail sai até a fase do envio real, a verificação do domínio (SPF, DKIM, DMARC) e a sua autorização escrita. Não existe botão de "enviar teste" por isso.

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

## O que ainda falta para enviar de verdade
Adaptador de envio, SPF/DKIM/DMARC do domínio, tratamento de e-mails devolvidos e a autorização escrita. Veja o checklist em *Integrações → Portão da emissão real*.
