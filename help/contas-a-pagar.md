# Contas a pagar

> **O sistema não paga nada.** Ele organiza e aprova as contas; quem tem alçada executa o pagamento **no banco (Cora), à mão**, e depois registra a **baixa** aqui.

## Onde fica
Menu **A pagar**. Fornecedores são cadastrados em *Clientes e fornecedores* (tipo "Fornecedor").

## Fluxo
1. **Lançar** (diretoria, gerente, assistente): fornecedor, descrição, nº do documento (nota/boleto/fatura), categoria, centro de custo, mês de competência, valor e vencimento. Nasce como **rascunho** e pode ser editado por quem lançou.
2. **Enviar para aprovação.** Depois de enviada, a conta **não pode ser alterada**: para corrigir, cancele e lance de novo.
3. **Aprovar ou rejeitar** (gerente e diretoria):
   - **Alçada:** o gerente aprova até o limite da empresa (padrão **R$ 5.000,00**); acima disso, só a diretoria.
   - **Segregação:** quem lançou não aprova a própria conta. A diretoria só pode, se essa chave estiver ligada na tela (fica registrado).
   - Rejeitar exige motivo e encerra a conta.
4. **Fila de execução:** contas aprovadas e em aberto, por vencimento, com CSV para quem vai pagar no banco.
5. **Registrar baixa** (diretoria e gerente): valor, data, forma e o **protocolo/comprovante** do banco. Baixa parcial é permitida; nunca passa do saldo; a data não pode ser futura.
6. **Estorno** da baixa (diretoria e gerente, com motivo): o histórico fica e o saldo volta.

## Proteções
- **Duplicidade:** o mesmo número de documento para o mesmo fornecedor é **bloqueado** (sem diferenciar maiúsculas/minúsculas nem espaços sobrando). Mesmo valor e vencimento para o mesmo fornecedor pede **confirmação** explícita ("não é a mesma conta").
- Conta **paga** é calculada pelas baixas, nunca marcada à mão.
- Conta com baixa registrada (mesmo estornada) **não pode ser cancelada**: o histórico precisa existir.
- Rejeitadas e canceladas liberam o número do documento para um novo lançamento correto.
- A auditoria guarda só identificadores (sem valores, nomes ou descrições).

## No painel (Início)
"A pagar (aprovadas)" e "A pagar vencidas" entram nos indicadores, e o gráfico **Saídas programadas — 13 semanas** mostra as contas aprovadas e as ainda aguardando aprovação. O resultado projetado considera **só o confirmado**: entradas confirmadas − saídas aprovadas. Despesas que não foram lançadas aqui (folha, impostos, tarifas…) não aparecem.

## Quem pode
- Ver: diretoria, gerente, assistente, contabilidade.
- Lançar/editar rascunho/cancelar rascunho: diretoria, gerente, assistente.
- Aprovar, rejeitar e cancelar contas enviadas: diretoria e gerente (com a alçada).
- Registrar baixa e estornar: diretoria e gerente.
- Exportar CSV: diretoria, gerente e contabilidade.
- Alterar alçada: diretoria.

> Anexos (nota fiscal/boleto em PDF) ficam para a próxima entrega, junto com os comprovantes de contas a receber, por exigirem armazenamento de arquivos com revisão de segurança própria.


## Recorrentes, parcelas e calendário
**Onde:** em **Contas a pagar**, botões **Calendário** e **Recorrentes e parcelas**.

- **Conta recorrente** (Vivo, energia, Simples, salários…): cadastre uma vez o fornecedor, a descrição, o **valor esperado**, o **dia do vencimento** (dia 31 em meses curtos vale o último dia), a categoria, o centro de custo e de qual mês até qual mês vale. Para mudar o valor esperado, o dia ou o mês final, edite na própria linha; vale para os meses **ainda não gerados**.
- **Parcelamento** (empréstimo, consórcio, carro): informe fornecedor, descrição, **número de parcelas**, **primeiro vencimento** e o valor de cada parcela. Se já pagou algumas, cadastre o primeiro vencimento **ainda em aberto** e as parcelas que restam. A tela mostra quantas foram pagas, quantas restam, o valor restante e o último vencimento. **Encerrar** o parcelamento para de prever as parcelas que ainda não foram geradas.
- **Calendário:** mostra, mês a mês e dia a dia, o que vence (rascunho, aguardando aprovação, aprovada, paga…) e o que está **previsto** mas ainda não virou conta. O total do mês soma o lançado e o previsto.
- **Gerar o mês:** cria **rascunhos** das previstas do mês (quem lança, aprova e baixa segue o fluxo normal). Pode clicar de novo sem medo: o que já foi gerado não duplica, e **um rascunho cancelado de propósito não volta**. Fornecedor suspenso/cancelado: a conta não é gerada até reativar o cadastro.
- A competência de uma conta gerada por modelo não muda (é ela que impede a duplicação). Valor e vencimento do rascunho podem ser ajustados antes de enviar para aprovação.
- O sistema **não aprova nem paga nada sozinho**.

**Quem pode:** ver, todos os que veem contas a pagar; **gerar o mês**, quem lança contas (diretoria, gerente, assistente); **cadastrar/alterar/encerrar** modelos e parcelamentos, a diretoria.
