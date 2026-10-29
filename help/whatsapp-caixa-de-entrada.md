# WhatsApp: respostas de clientes, «PARAR» e triagem

**Quem acessa:** diretoria e gerência veem a caixa e atendem. Só a diretoria registra pedido de parar para **todas as empresas** e usa a **triagem**.
**Onde:** **WhatsApp → Caixa de entrada**.

> **Não há robô nem resposta automática.** O sistema só **recebe, classifica e protege**. Para responder ao cliente, use o próprio WhatsApp do aparelho conectado.

## O que acontece quando o cliente responde
1. A WAHA avisa o sistema por um canal **assinado** (HMAC). Aviso sem assinatura válida é **descartado** e não grava nada. O mesmo aviso repetido vira **um registro só**.
2. O sistema descobre **de qual empresa** é a conversa de forma **segura**: só se uma única empresa falou com aquele número nos últimos 14 dias, ou se ele é contato de uma única empresa. **Na dúvida, vai para a triagem.**
3. A resposta aparece na caixa da empresa e a **cobrança daquele cliente fica suspensa** até você marcar a conversa como **resolvida** (e, se houver, **limpar a contestação**).

## Pedido de parar («PARAR», «SAIR», «NÃO ME ENVIE»…)
- Reconhecido **na hora**: o contato é bloqueado, as mensagens dele na fila viram *suprimido* e o sistema **não responde nada**.
- Se a conversa é de uma empresa, o bloqueio vale **para ela**; se o cliente pede **parar tudo** («não me envie nenhuma mensagem») ou o sistema **não sabe de qual empresa é**, o bloqueio vale para **todas** (na dúvida, bloqueia mais).
- **Casos ambíguos** («quero cancelar o contrato», «isso é spam») **bloqueiam por precaução** e ficam marcados **Revisar** para uma pessoa decidir.
- O bloqueio **nunca é desfeito sozinho**. Para voltar a cobrar, registre um novo consentimento com prova (WhatsApp → Consentimentos).

## Ações em cada resposta
- **Em atendimento / Resolver:** controla a suspensão da cobrança.
- **Marcar contestação:** segura a cobrança mesmo depois de resolvida, até você **limpar** a contestação.
- **Registrar: parar nesta empresa / em todas as empresas:** para quando o cliente pediu parar com outras palavras.

## Triagem (só diretoria de todas as empresas da conexão)
Mensagens que o sistema **não conseguiu ligar com segurança a uma empresa**: número desconhecido, número usado por mais de uma empresa ou identificador que a WAHA não traduziu. **Nenhuma empresa as vê** até você escolher: **Atribuir à empresa** ou **Descartar**.

## Entrega e leitura
Quando a confirmação de **entrega** ou **leitura** chega da WAHA, o **Histórico** passa a mostrá-la (só para mensagens que o próprio sistema enviou).

## Privacidade
O texto da resposta fica **cifrado** no banco e só aparece aqui, para quem tem acesso. Listas mostram o telefone **mascarado**. Fotos, áudios e arquivos **não são baixados**.
