# Autorizações (liga/desliga)
**Quem acessa:** todos veem; só a diretoria liga e desliga
**Onde:** Configurações → Autorizações

Um painel único com uma **chave por função**. Antes havia que marcar, escrever frases e clicar em vários lugares; agora é **um clique**.

## As chaves
- **Faturamento automático:** o sistema **gera a prévia** de cada lote sozinho (2 dias úteis antes da data de emissão: 1, 8, 15 e 25) e, quando você usa **Aprovar e agendar emissão** no lote, **emite os boletos no dia certo, às 09:00** (se a data cair em fim de semana ou feriado, no dia útil anterior). **Nunca aprova nada por você** e mantém todas as travas (pausa, limite diário, modo cuidadoso, conferência de duplicidade). Desligar volta tudo ao modo manual. Fica registrado quem ligou e quando.
- **Boletos reais (Cora):** liga a emissão de boletos de verdade (cobram o cliente). Pede uma confirmação. Começa em **modo cuidadoso** (no máximo 3 boletos por dia). Desligar **pausa** a emissão. Se já houver boletos **solicitados e ainda não enviados** (pedidos antes de ligar os reais), o painel mostra o botão **Cancelar solicitações pendentes**: nada é emitido, e depois é só solicitar de novo no lote. Os boletos só nascem quando um lote aprovado tem a emissão solicitada e processada em Faturamento → Emissões.
- **E-mail para clientes:** o sistema passa a enviar cobranças e lembretes, com o **boleto e a nota fiscal em anexo**, aos **contatos financeiros** cadastrados dos clientes. Defina o **limite por dia**. Pede antes a conta de e-mail (Integrações → E-mail).
- **E-mail do sistema (senha e convites):** chave **separada** da de clientes. Liga o envio da **redefinição de senha** («Esqueci minha senha») e dos **convites de acesso**. Nunca envia cobrança e escreve a uma pessoa por vez. Também pede a conta de e-mail cadastrada. Desligada, a senha e o convite só funcionam por **link manual** (Configurações → Membros).
- **WhatsApp para clientes:** liga a cobrança por WhatsApp (limite por dia). **Cada contato continua precisando de consentimento** (WhatsApp → Consentimentos); quem pede «PARAR» nunca mais recebe.
- **Régua automática:** avisos automáticos nos dias escolhidos (3 dias antes, no vencimento, 3 e 7 dias depois). Depende do WhatsApp ligado.

## Conferência de pagamentos na Cora
Na chave de **Boletos reais** aparece se a plataforma está conferindo os pagamentos: hora da última conferência, quantos boletos olhou e quantos estavam pagos. Ela roda **sozinha a cada 10 minutos** (com a baixa automática ligada) e, se parar por mais de 30 minutos, o aviso fica em destaque. O aviso instantâneo da Cora (webhook) é um reforço: quando não está registrado, vale a conferência de 10 minutos.

## Como funciona
- Ligar e desligar vale **na hora** e fica no **Registro de atividades** (quem e quando): essa é a autorização.
- **Só a diretoria** altera. Gerente e demais papéis veem o estado, sem poder mudar.
- **Chave de emergência do servidor:** cada função tem também uma chave no servidor. Se ela estiver desligada, o painel avisa e a função não liga. É a parada de emergência da equipe técnica.
- **Continuam valendo** os limites diários, a conferência da Cora contra boleto duplicado e o consentimento de cada contato do WhatsApp.
- **Nota fiscal:** não tem chave. Ela segue junto do boleto para os clientes marcados «exige NF junto do boleto» assim que o PDF é anexado ao lote.

## Erros comuns
- *«Desligado neste servidor»*: a chave de emergência está desligada; peça à equipe técnica.
- *«Cadastre antes a conta de e-mail»*: faça em Integrações → E-mail e use «Testar conexão».
- *«Há boletos em andamento»*: conclua ou cancele as solicitações de boleto antes de trocar o modo.

Última atualização: 2026-11-04.
