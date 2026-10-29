# Mensagens e régua de cobrança (simulação)

> **Simulação.** Nesta fase nenhum e-mail nem WhatsApp é enviado. A tela mostra o que *seria* enviado, para você conferir texto, datas e destinatários antes de ligar o envio real.

## Onde fica
Menu **Mensagens** (fila) e **Mensagens → Modelos** (textos).

## A régua
Para cada cobrança de um lote **aprovado**, a fila prevê:

| Etapa | Data |
|---|---|
| Emissão | data de emissão da cobrança |
| Lembrete D-3 | 3 dias antes do vencimento |
| Vencimento D0 | no dia do vencimento |
| Atraso D+3 e D+7 | 3 e 7 dias depois |
| Revisão humana D+15 | 15 dias depois — **tarefa interna**, não é mensagem ao cliente |

Cada etapa sai por **e-mail** e **WhatsApp**.

## Passo a passo
1. **Modelos → Criar modelos padrão.** Cria os textos iniciais, já ativos em seu nome. Revise cada um.
2. Para mudar um texto: abra o modelo, edite, **Salvar rascunho**, confira a **prévia com dados fictícios** e clique **Ativar**. A versão anterior fica guardada e pode ser restaurada.
3. **Mensagens → Programar mensagens** monta a fila das cobranças aprovadas. Pode repetir à vontade: não duplica.
4. **Processar vencidos (simulação)** grava o texto final das mensagens cuja data chegou. Use **Ver texto simulado** para conferir.

## Regras de segurança
- Os textos são **texto simples**. HTML é recusado. Só os campos {{cliente}}, {{empresa}}, {{valor}}, {{vencimento}}, {{competencia}}, {{descricao}} e {{emissao}} existem; qualquer outro é recusado.
- O assunto do e-mail tem uma linha só.
- **Bloqueado:** o cliente não tem contato financeiro com e-mail (ou telefone, no WhatsApp). Cadastre o contato e use *Programar mensagens* de novo.
- Se o lote for **reaberto** ou cancelado, as mensagens ainda não processadas são **canceladas** automaticamente. Ao reaprovar, programe de novo. O que já foi simulado fica no histórico.
- Etapas sem modelo ativo não entram na fila (o aviso mostra quantas).
- Datas que já passaram no momento de programar não entram.

## Quem pode
- Ver: diretoria, gerente, assistente e contabilidade.
- Programar e processar: diretoria, gerente e assistente.
- Editar e ativar modelos: diretoria e gerente.

## Configuração de envio e agendador (Mensagens → Configuração)
- **Pausar tudo:** chave de emergência. Com ela ligada nada é processado, nem manual nem automático.
- **Envio automático:** um agendador (a cada minuto) processa a fila sozinho **só nas empresas em que isto estiver ligado**. Vem desligado.
- **Canais:** e-mail vem ligado; **WhatsApp vem desligado** (WAHA não é oficial e a conta pode ser bloqueada).
- **Janela:** horário de Manaus e dias da semana permitidos (padrão seg–sex, 09:00–18:00), sem feriados nacionais nem os cadastrados em Faturamento. Fora da janela o agendador espera. O botão manual *Processar vencidos* ignora a janela, mas respeita pausa, canais e limites.
- **Limites:** máximo por execução e por hora.
- **Tolerância:** mensagem com mais dias de atraso que o permitido (padrão 2) **não sai**; vai para *Bloqueado* para decisão manual. Um lembrete "vence em 3 dias" depois do vencimento não faz sentido.
- **Falhas:** erro temporário tenta de novo (até 3 vezes); erro definitivo bloqueia o item com o motivo.
- Destinatários: só contatos **financeiros** do cliente, com e-mail válido, sem repetição (até 3 por mensagem).
- Quem altera a configuração: diretoria e gerente.

## Provedores
Em *Integrações → Provedores* aparecem Cora (somente boletos), NFS-e da Cora (beta), SMTP e WAHA. Todos **simulados**. Se alguma chave de envio real for ligada no servidor sem existir adaptador homologado, o sistema **recusa enviar** e mostra um aviso.

## E-mail real (canário)
Em geral tudo aqui é **simulado**. Se a diretoria registrou a autorização de envio real e a chave do servidor está ligada (o topo mostra **E-MAIL REAL ATIVO**), *Processar fila* envia e-mails de verdade, **só** para contatos da lista autorizada. Itens ganham os status **Enviando** e **Enviado (real)**; os fora da lista ficam *Bloqueados*. Mensagem enviada não pode ser apagada nem alterada. Detalhes em *Conta de e-mail (SMTP)*.

## Boleto no e-mail (E33)
Os modelos aceitam dois campos novos: **`{{linha_digitavel}}`** (linha digitável do boleto, consultada na Cora na hora do envio) e **`{{link_boleto}}`** (link do PDF). Os modelos **padrão** novos já trazem a linha digitável e avisam que o **PDF segue em anexo**. Modelos já existentes não mudam sozinhos: edite-os para incluir o campo.
- **Empresa com boleto na Cora (testes ou produção):** a mensagem só sai quando o boleto **existe e está em aberto**. Sem boleto (ainda não emitido, pago ou cancelado) ela **espera**; boleto pago ou cancelado para a régua. No e-mail real, o **PDF do boleto vai em anexo** (se o PDF não puder ser baixado, o e-mail **não sai sem o boleto**: volta à fila e tenta de novo).
- **Empresa com boleto simulado:** o texto mostra "(boleto simulado)" e o **e-mail real é bloqueado** se o modelo usa o boleto (nunca vai boleto de mentira a cliente de verdade).
- Continua valendo o canário do e-mail: só com autorização escrita, lista de destinatários e pelo botão **Processar fila** (o agendador não envia e-mail real).

