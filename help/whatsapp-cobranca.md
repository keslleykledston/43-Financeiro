# WhatsApp: cobrar clientes (manual e assistido)

**Quem acessa:** diretoria libera a empresa e confere mensagens «sem confirmação». Diretoria e gerência colocam na fila, enviam, cancelam e veem o histórico. Os demais papéis não veem estas telas.
**Onde:** em **Contas a receber → (cobrança) → Enviar por WhatsApp**; **WhatsApp → Histórico**; **WhatsApp → Configuração**.

> **Nada é automático.** Cada mensagem é escolhida, revisada e enviada por uma pessoa, uma de cada vez. A régua automática ainda não existe e continua **desligada**. A WAHA é um canal **não oficial**: o número pode ser restringido e os limites do sistema **não eliminam esse risco**.

## Antes do primeiro envio (uma vez por empresa)
1. **Conexão** conectada e liberada (WhatsApp → Conexões).
2. **Liberar a empresa** em **WhatsApp → Configuração**: informe onde está a autorização escrita, o limite diário (1 a 10) e **digite a frase** de confirmação. Só a diretoria faz isso. É possível desligar a qualquer momento.
3. **Modelos:** em Configuração, *Criar/atualizar modelos padrão*. Os padrões são curtos, identificam a empresa e **não levam dados do boleto**. Modelo que usa linha digitável/link/Pix aparece como «indisponível» para WhatsApp.
4. **Consentimento** do contato em **WhatsApp → Consentimentos** (sem ele, **não envia**).
5. O cliente precisa ter **contato financeiro com celular** (o telefone fixo não serve).

## Como enviar uma cobrança
1. Abra a cobrança e clique em **Enviar por WhatsApp**.
2. Escolha o **modelo** e a **conexão** e clique em **Conferir**: aparece a **prévia** exata do texto e a **lista de verificação** (cada item verde ou bloqueado, com o motivo).
3. Marque a confirmação e clique em **Colocar na fila**. O texto fica **fixado** (cifrado).
4. Em **WhatsApp → Histórico**, clique em **Enviar**. Só então a mensagem sai.

## O que o sistema revalida na hora de enviar
Chave do servidor, empresa liberada, conexão **lida na WAHA agora**, cobrança **ainda em aberto**, consentimento e pedido de parar, janela de envio, limites (empresa, conexão) e **no máximo 1 aviso por cliente a cada 7 dias**. Também confere se o **texto de agora é igual ao aprovado**: se valor, vencimento ou modelo mudaram, não envia (cancele e coloque outra).
- **Cobrança paga, lote reaberto, cobrança cancelada ou pedido de parar** → a mensagem na fila vira **«suprimido»** (com o motivo) e **não sai**.
- **Fora da janela, limite do dia, conexão pausada/caída ou chave desligada** → a mensagem **continua na fila**; tente de novo depois.

## Situações
| Situação | O que significa |
|---|---|
| Na fila | Pronta; espera você clicar em *Enviar*. |
| Enviado | A WAHA confirmou o envio. Entrega/leitura só aparecem quando a confirmação chega. |
| Sem confirmação | A WAHA não respondeu a tempo: **pode ter chegado**. **Nunca é reenviada sozinha.** Confira com o cliente e use *Confirmei: foi enviada* ou *NÃO foi* (só a diretoria). |
| Falhou | A WAHA recusou, ou o número não está no WhatsApp. Nada foi enviado. |
| Suprimido | Não deve mais sair (paga, sem consentimento, pediu para parar...). |
| Cancelado | Você cancelou antes de enviar. |

## Privacidade
O histórico mostra o **telefone mascarado**; o texto enviado fica **cifrado** e é aberto só no registro, por quem tem acesso ao histórico. A auditoria não guarda telefone nem texto. Cada empresa vê só o seu histórico.
