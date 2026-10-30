# WhatsApp: régua automática e painel

**Quem acessa:** diretoria liga e desliga a régua. Diretoria e gerência veem a simulação e o painel. Os demais papéis não veem a tela.
**Onde:** **WhatsApp → Régua e painel**.

> **A régua nasce DESLIGADA e nada sai sozinho enquanto a diretoria não ligar.** A WAHA é um canal **não oficial**: o número pode ser restringido e os limites do sistema **não eliminam esse risco**. Comece com **uma régua só** e acompanhe o painel.

## Três chaves independentes
1. **Chave do servidor** (`WHATSAPP_AUTOMATION_ENABLED`): decisão operacional da equipe técnica, junto com o envio e o módulo. Desligada, **nada sai sozinho**, mesmo com a régua ligada na empresa.
2. **A empresa:** a cobrança por WhatsApp precisa estar liberada (WhatsApp → Configuração). A diretoria então liga a régua informando **onde está a aprovação**, **digitando a frase** de confirmação e **escolhendo as réguas**.
3. **Cada régua:** D-3 (3 dias antes do vencimento), D0 (no vencimento), D+3 e D+7 (atrasos). Não existe régua de emissão automática.

## O que a régua faz (e o que nunca faz)
- Todos os dias, o agendador procura cobranças **em aberto** que caem **no dia exato** de uma régua ligada e tenta enviar o modelo de WhatsApp ativo daquele marco.
- Cada mensagem passa pela **mesma verificação e pelo mesmo envio** da cobrança manual: consentimento registrado, pedido de parar, **resposta do cliente pendente**, cobrança ainda devida (lida de novo na hora de enviar), janela de envio, limites diários, **no máximo 1 aviso por cliente a cada 7 dias**, conexão lida na WAHA e texto idêntico ao aprovado.
- **Pagou, não sai:** a baixa (manual, conciliação ou Cora) suprime o que estava na fila e o envio confere a dívida de novo, antes e depois de consultar o número. Se o pagamento chegar **no exato instante** em que a mensagem já está sendo entregue ao WhatsApp, ela pode sair mesmo assim (janela de segundos que nenhum sistema elimina por completo).
- **Só no dia certo:** não recupera dia perdido (um «D-3» tardio não faz sentido). O que ficou na fila de um dia **não sai no dia seguinte** (aparece como «Régua: o dia do marco passou sem sair»). Se o dia cair em fim de semana, feriado ou fora da janela, aquela cobrança não recebe esse marco.
- **Só a partir do dia seguinte** ao de ligar, para dar tempo de conferir a simulação.
- **Uma tentativa por cobrança e marco.** Falha ou «sem confirmação» **nunca** tenta de novo sozinha (confira em Histórico).
- Ritmo calmo: no máximo 2 envios por empresa a cada minuto, com pausa entre eles.
- A régua roda **em nome de quem a ligou**. Se essa pessoa perder a permissão, ela **para** e o painel avisa. Desligue e ligue de novo com outra pessoa da diretoria.
- O sistema **não responde** a clientes e **não conversa**: respostas vão para a Caixa de entrada e **suspendem** a cobrança daquele cliente até alguém resolver.

## Simulação (não envia nada)
A tela mostra, para o dia escolhido, cada cobrança que cairia em D-3, D0, D+3 ou D+7 e o resultado: **Sairia**, **Esperaria** (janela, limite ou conexão), **Não sairia** (sem consentimento, pediu para parar, paga, aviso recente…) ou **Já tratada**. Use antes de ligar e depois, para conferir.

## Painel dos últimos 30 dias
Enviadas, entregues, lidas, na fila, falhas, sem confirmação, suprimidas (com o motivo), pedidos de parar, respostas, contestações e mensagens criadas pela régua. Também mostra **cobranças pagas até 7 dias depois de um aviso enviado**. Isso é apenas **coincidência de datas**: o painel **não afirma** que o aviso causou o pagamento.

## Desligar
**Desligar régua automática** vale na hora e suprime o que está na fila automática. Desligar a cobrança por WhatsApp da empresa também desliga a régua. Para uma pausa rápida de tudo, pause a conexão (WhatsApp → Conexões).
