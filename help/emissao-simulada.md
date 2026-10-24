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

## Controles
- Começa **pausado**. A diretoria libera, define o **limite diário** e pode pausar de novo a qualquer momento.
- **Lote com emissão em andamento ou concluída não pode ser reaberto.** Solicitações ainda não enviadas são canceladas ao reabrir.

## O que falta para a emissão real
Veja *Integrações → Portão da emissão real*: credenciais fora do Git, homologação, calendário fiscal aprovado e **autorização escrita da diretoria**. O roteiro completo está em `docs/E10_GOLIVE.md`.

## Cancelar boleto
A diretoria pode cancelar um boleto emitido e sem pagamento, com motivo e tudo registrado: veja `cancelar-boleto.md`.
