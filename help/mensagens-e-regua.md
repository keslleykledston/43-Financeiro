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

Cada etapa sai por **e-mail** e **WhatsApp**. Fins de semana, feriados e horários permitidos de envio entram na fase dos provedores.

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
