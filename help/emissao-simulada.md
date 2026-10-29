# Emissões (boleto e NFS-e) — motor simulado

> **Simulação.** Nada é emitido de verdade. Esta tela ensaia o caminho completo para que, no dia em que a emissão real for liberada, o comportamento já esteja testado.

## Onde fica
*Faturamento → Emissões.* No lote aprovado, os botões **Solicitar boletos** e **Solicitar NFS-e** só colocam as cobranças na fila do motor.

## Como funciona
1. **Solicitar** (diretoria e gerente): uma solicitação por cobrança e por tipo; cobrança quitada não entra.
2. **Processar agora (simulado)**: o motor reserva a solicitação, chama o provedor simulado e registra o resultado.
3. O sistema **nunca emite duas vezes** a mesma cobrança. Se a resposta se perder (queda de conexão, erro inesperado), a solicitação vira *Resultado desconhecido* e a próxima rodada **reconsulta** o provedor antes de tentar de novo. Depois de 5 tentativas sem resposta conclusiva, vai para *Falhou* com o aviso de que um humano deve conferir no provedor.
4. **NFS-e** é assíncrona: fica *Processando no provedor* até a consulta de status confirmar.
5. Se a cobrança for quitada ou cancelada antes do envio, a solicitação é cancelada automaticamente.

## Provedor de boleto (simulado ou Cora de testes)
Em *Controle* há o campo **Provedor de boleto**. O padrão é **Simulado**. A diretoria pode escolher **Cora — testes (homologação)**: o boleto passa a ser criado de verdade no ambiente de testes da Cora (com número e linha digitável de teste), mas **não é um boleto real e não cobra ninguém**. NFS-e continua simulada.
- Só funciona se o servidor estiver com a Cora de testes ligada e a empresa tiver as credenciais de **Homologação** em *Integrações → Cora*. Sem isso a troca é recusada e nada é enviado.
- Só dá para trocar de provedor quando **não há boletos em andamento** (aguardando, enviando ou a reconsultar). O boleto guarda para sempre o provedor que o emitiu: reconsulta e cancelamento falam com ele.
- **Não existe emissão em produção** nesta versão: ela exige autorização escrita da diretoria e uma nova fase de desenvolvimento.
- O cancelamento de um boleto da Cora de testes cancela de fato lá (ambiente de testes).

## Controles
- Começa **pausado**. A diretoria libera, define o **limite diário** e pode pausar de novo a qualquer momento.
- **Lote com emissão em andamento ou concluída não pode ser reaberto.** Solicitações ainda não enviadas são canceladas ao reabrir.

## Atualizar situação na Cora
Com o provedor **Cora — testes**, o botão **Atualizar situação na Cora** (Emissões → Controle) consulta cada boleto emitido na Cora de testes. É **só consulta**: nada é pago nem cobrado.
- **Pago na Cora:** a linha mostra "na Cora: PAGO (confira e dê a baixa)" e as mensagens de cobrança param. **A baixa continua manual** (A receber ou Conciliação).
- **Cancelado por fora da plataforma:** a solicitação vira *cancelado*; a cobrança fica sem boleto ativo e você pode solicitar outro.
- **Aberto ou atrasado:** nada muda.
Cada rodada confere até 50 boletos; se houver mais, clique de novo. Se a Cora limitar o acesso, a rodada para e avisa.

## O que falta para a emissão real
Veja *Integrações → Portão da emissão real*: credenciais fora do Git, homologação, calendário fiscal aprovado e **autorização escrita da diretoria**. O roteiro completo está em `docs/E10_GOLIVE.md`.

## Cancelar boleto
A diretoria pode cancelar um boleto emitido e sem pagamento, com motivo e tudo registrado: veja `cancelar-boleto.md`.
