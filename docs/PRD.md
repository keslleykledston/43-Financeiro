# PRD — K3G Finance (v1, 2026-10-22)

## 1. Visão e problemas
K3G Solutions (consultoria/monitoramento de redes) e K3G Call (call center/suporte para provedores) são CNPJs distintos; ~51-150 clientes ativos combinados. Serviços recorrentes pós-pagos, contratos assinados, cobranças via Cora (boletos/PIX), NF de serviços pelo sistema e-NF. Cada CNPJ possui **conta Cora própria**. Dados em Google Sheets separados e processamento manual de recebimentos, despesas, folha e conciliação. Custos e funcionários compartilhados. Diretora financeira executa pagamentos; gerente/diretora aprovam.

Objetivo: diminuir digitação e conferência, reduzir erros, centralizar controles por CNPJ, consolidação do grupo, dar visibilidade real e previsibilidade ao caixa. Não construir ERP contábil completo.

## 2. Pessoas e permissões
- Admin técnico: configura app/usuários, não tem necessariamente acesso a finanças sem permissão financeira explícita.
- Diretora financeira: visão completa das duas empresas, gestão de aprovações e fechamento, exportação.
- Gerente financeira: operação, revisão, relatórios e aprovações limitadas a alçada futura.
- Assistente financeiro: cadastros, lançamentos, importação e triagem, sem executar pagamentos.
- Diretoria executiva: dashboards e relatórios, read-only.
- Contabilidade: acesso delimitado a relatórios/documentos necessários e autorizado.
Perfis e alçadas específicos são configuráveis, ainda não definidos. Aplicar princípio de menor privilégio.

## 3. Jornadas MVP prioritárias
1. Admin entra com login individual e seleciona K3G Solutions, K3G Call ou Grupo (grupo só agrega onde apropriado).
2. Financeiro cadastra cliente e contrato com mensalidade, serviço, competência pós-paga e vencimento.
3. Sistema prevê faturas por competência, agrupadas em lotes, informa próximas emissões e exceções.
4. Gerente/diretora revisa lote (inicialmente todas as emissões para segurança); fluxo de emissão externa **desabilitado** até habilitação explícita.
5. Financeiro cria/edita templates e prévia de e-mails, simula o agendamento sem enviar.
6. Financeiro visualiza contas a receber, marca recebimento manual documentado ou concilia extrato.
7. Diretora vê dashboard por empresa e consolidado, saldos rotulados conciliados/projetados e pendências.
8. Usuários consultam central de ajuda contextual nas telas.

## 4. Faturamento pós-pago — CONFIRMADO
Competência M: serviço prestado no mês M. Vencimento: mês M+1. Datas padrão para mês VENCIMENTO D:
- Vencimento 1–12, SEM exigência de NF conjunta: emitir boleto em 25 do mês anterior a D; NF conforme regra fiscal a definir.
- Vencimento 1–12, COM exigência de NF conjunta: emitir boleto e NF no dia 1 de D; e-mail só após ambos emitidos (atenção para vencimento no dia 1).
- Vencimento 13–16: emissão boleto dia 1 de D.
- Vencimento 17–22: emissão boleto dia 8 de D.
- Vencimento 23–30: emissão boleto dia 15 de D.
- Vencimento dia 31 não coberto pela regra operacional confirmada: marcar `NEEDS_REVIEW` e não emitir automaticamente até configuração.
- Fevereiro e meses curtos: não substituir vencimento contratual sem validação do contrato/cliente e da política bancária; situação pendente deve gerar alerta e opção de ajuste aprovado. Em protótipo pode-se demonstrar último dia do mês **somente como proposta explicitamente sinalizada**.
- Fim de semana/feriado e horários/cutoff: política pendente, usar calendário configurável e flag de revisão.
- Serviço de competência M cobrado no dia 25 de M pode ser emitido antes do fechamento da competência: destacar no lote e validar situações com alteração de consumo/serviço e implicação fiscal.
- NF de outros casos: regras específicas de emissão/tributação NÃO definidas, dependem da contabilidade e do e-NF. Não inferir que NF sempre é emitida no mesmo dia do boleto.
- Reajuste, suspensão, proporcionalidade, descontos: regras configuráveis, revisão humana enquanto não confirmadas.
- Duplicidades bloqueadas por (`company_id`, `contract_id`, `competence_month`, `charge_kind`, `sequence` quando parcelas).
- Importante separar `competence_month`, `scheduled_issue_at`, `issued_at`, `due_date`, `paid_at`, `bank_settled_at`.

## 5. Cobranças, comunicação e documentação
- Boleto via Cora, NF via e-NF após validação das APIs e homologação. Acesso Cora por CNPJ independente.
- Email inicial com anexos/links autenticados com prazo seguro, assinatura e template da empresa.
- Templates: assunto, corpo, placeholders explicitamente permitidos, prévia com dados sintéticos, versionamento, revisão/autorização e registro do template efetivamente enviado.
- Régua proposta para configuração futura: envio na emissão, lembrete D-3, D0, cobrança D+3, D+7, revisão humana D+15. Não ativar réguas reais antes de confirmação operacional e validação LGPD.
- Antes de enviar cobrança, confirmar situação mais recente do título e suspensão/acordo/contestação. Se banco incerto, texto cauteloso. Stop-on-payment, cancelamento, acordo, erro fiscal.
- Nunca registrar `sent` antes da resposta válida do provedor; deduplicar event/outbox e reconciliar tentativas desconhecidas. Logs sem conteúdo pessoal quando possível.

## 6. Conciliação e contas a pagar
- Extratos independentes K3G Solutions/Call; transações originais imutáveis, importação idempotente, alocação por identificador confiável, revisão humana em ambiguidades.
- Reconciliação múltipla/parcial, ajustes/estornos e transferências entre CNPJs que não viram receita do grupo.
- Contas a pagar com fornecedor, vencimento, anexos, autorização. Diretora financeira executa pagamento no Cora, fora do sistema até integração aprovada. Não iniciar pagamentos por padrão.

## 7. Indicadores essenciais (apenas dados reais identificados)
Saldo por conta (fonte/data), a receber vencido/em aberto, a pagar em aberto, faturamento por competência, recebimentos por caixa, inadimplência, despesas por categoria, receita recorrente mensal, concentração por cliente, gastos de pessoal, DRE gerencial, previsões semanais 13 semanas. Consolidação sem duplicar intercompany. Usar 'sem dados suficientes' em vez de número inventado.

## 8. MVP vs futuro
IN MVP: app web, autenticação/RBAC, empresas, clientes, contratos, calendário, prévias, aprovação humana, templates e prévias de e-mail, AR, importação bancária, conciliação básica, API v1, dashboard simples, help, deploy seguro.
FUTURO: integração real Cora/e-NF/SMTP por estágio, AP robusto, rateios, folha, DRE, orçamento, previsões, IA explicativa, analytics avançado, administração de cobrança multicanal.

## 9. Metas e métricas
- Primeira interface testável online o mais cedo possível (após segurança e DNS).
- Tempo por tarefa, falhas, velocidade de fechamento, % de lançamentos conciliados, duplicações = zero, relatórios por CNPJ e consolidado.
- Todas as metas são propostas de acompanhamento, não promessas técnicas.

## 10. Pendências que NÃO bloqueiam app demo
Documento fiscal e-NF: API e compliance, alçadas finais, exceções dia 31, feriados, clientes NF não conjunta, provedor de e-mail, DNS/privilégios/HTTPS, credenciais Cora, regras de rateio, escopo de dados de folha. Registrar cada pendência em `agent/memory/BLOCKERS.md`; solução simulada bem rotulada até validação.
