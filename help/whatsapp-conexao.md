# WhatsApp: conectar o número e enviar um teste

**Quem acessa:** diretoria e admin técnico conectam e desconectam o número. Diretoria registra a autorização de envio. Diretoria e gerência enviam o teste. Os demais papéis não veem o menu.
**Onde:** menu **WhatsApp** (conexões) e **WhatsApp → Enviar teste**.

> **Aviso importante:** a conexão usa a **WAHA**, uma tecnologia **não oficial** baseada no WhatsApp Web. O número pode desconectar ou ser restringido pelo WhatsApp, e os limites do sistema **não eliminam esse risco**. Mantenha outro canal (e-mail, telefone) para o que for crítico. Esta etapa não envia cobrança, não tem régua e não responde automaticamente.

## Como conectar um número
1. Em **WhatsApp**, preencha **Nome interno** (só para vocês), **Como o cliente vê quem escreve** (o nome real da empresa que cobra) e marque a confirmação de que **tem autorização para usar o número**.
2. Clique em **Conectar WhatsApp**. O cartão da conexão mostra «Aguardando leitura do QR» e, em seguida, o **QR Code**.
3. No celular, abra o WhatsApp → **Aparelhos conectados** → **Conectar um aparelho** e aponte a câmera para o QR. O QR **troca sozinho** a cada poucos segundos; se expirar, espere o novo aparecer.
4. Quando a situação mudar para **Conectada**, o número aparece mascarado (ex.: `+55 92 •••••-1234`).
5. A conexão nasce **pausada**. Nada sai por ela até alguém clicar em **Liberar envios**.

O QR e a chave da WAHA ficam só no servidor: a tela recebe o QR por uma rota autenticada, sem cache, e a chave nunca vai para o navegador.

## Situações da conexão
| Situação | O que significa |
|---|---|
| Criada / Iniciando | A conexão foi criada ou está subindo. |
| Aguardando leitura do QR | Falta ler o QR no celular. |
| Conectada | Número ligado e pronto. Não garante que a mensagem será entregue. |
| Desconectada | O número saiu ou a conexão foi parada. Use **Iniciar / conectar**. |
| Com problema | A WAHA não respondeu ou deu erro. Tente de novo; se persistir, avise a equipe técnica. |

## Pausar, liberar e desconectar
- **Pausar envios** bloqueia qualquer envio por aquela conexão, na hora.
- **Liberar envios** só funciona com a conexão **Conectada**; as outras travas continuam valendo.
- **Desconectar número** (com confirmação) faz logout do aparelho e pausa a conexão. O **histórico fica**; nada é apagado.

## Enviar uma mensagem de teste
O teste existe para provar que a conexão funciona, **com texto fixo e sem dado de cliente**.
1. Em **WhatsApp → Enviar teste**, a diretoria registra a **autorização**: onde está a autorização escrita, os números que podem receber (até 10, **um por linha**) e o limite diário (1 a 10).
2. Escolha a **conexão** e o **número de destino** (um dos autorizados) e clique em **Conferir**.
3. A **lista de verificação** mostra, item a item, o que está verde ou bloqueado e **por quê**. O botão de envio só libera com tudo verde.
4. Marque a confirmação e clique em **Enviar mensagem de teste**.

### O que bloqueia um envio
- chave do servidor de envio desligada, ou módulo/WAHA não configurados;
- conexão de outra empresa, pausada ou não conectada;
- envios da empresa pausados (Mensagens → Configuração);
- autorização ausente ou número fora da lista; número inválido;
- fora da janela de envio (horário, dia da semana, feriado, em Manaus);
- número que não existe no WhatsApp, ou que a consulta devolve diferente do autorizado;
- limite diário atingido: o da autorização, **10 por empresa** e **20 por conexão** (a conexão pode ser compartilhada entre empresas).

O limite diário conta as **tentativas reservadas** (inclusive uma consulta que bloqueou o envio). Todo bloqueio mostra o motivo na tela e fica registrado no *Registro de atividades*.

### «Número não encontrado» e o 9º dígito
Antes de enviar, o sistema **consulta o número no WhatsApp** (a consulta não envia nada). Se ele não existir, o envio é bloqueado com esse aviso. Algumas contas antigas do WhatsApp existem **sem o 9º dígito** do celular: o sistema aceita essa forma **somente** quando ela é o mesmo número que você autorizou (mesmo DDD e mesmos 8 últimos dígitos). Qualquer outra diferença bloqueia o envio.

### «Sem confirmação»
Se a WAHA não responder a tempo, o envio fica como **sem confirmação**: a mensagem **pode ter chegado**. O sistema **não reenvia sozinho**, para não duplicar. Confira o aparelho de destino.

## Privacidade
- O histórico guarda só o **número mascarado**, o resultado e quem enviou; **não guarda o texto**.
- Os números autorizados ficam em registro próprio, visível só nesta tela e mascarado.
- Cada empresa só vê as conexões vinculadas a ela.
