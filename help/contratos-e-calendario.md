# Contratos e calendário de faturamento

**Onde:** menus *Contratos* e *Faturamento*.

## Contratos (cadastrados aqui)
O K3G CRM não tem contratos; eles são mantidos **neste sistema**, ligados a um cliente.
1. *Novo contrato*: cliente, serviço, **valor mensal** (ex.: `2.500,00`), **dia de vencimento** (1–31), início da vigência (o **fim** só se o cliente encerrar), se o cliente **exige NF junto do boleto** e, se precisar, um dia de emissão personalizado.
2. O contrato nasce como **rascunho** e só passa a valer depois de **aprovado** por gerente ou diretoria. Quem cadastrou não aprova o próprio (a diretoria pode).
3. **Alterações** (valor, vencimento, vigência…) viram uma *versão pendente*. **Os termos atuais continuam valendo até a aprovação.** Tudo fica no histórico de versões.
4. *Suspender* e *Encerrar* são imediatos. *Reativar* exige gerente ou diretoria. **Encerrar é definitivo.**

## Quem gera cobrança
Só entra no calendário contrato **ativo** de cliente **ativo** (não arquivado) cuja **vigência cubra a competência**. Cliente suspenso ou cancelado fica de fora, mesmo com contrato ativo.

## Calendário (Faturamento)
Mostra **quando emitir** boletos e notas e **quando vencem**. É só previsão: **nada é emitido**.
- **Competência M** (mês do serviço), **vencimento em M+1**.
- **Quando emitir** (conforme o dia de vencimento):

| Vencimento | Emissão do boleto |
|---|---|
| dia 1–12, sem NF conjunta | dia **25** do mês anterior |
| dia 1–12, **com** NF conjunta | dia **1** do mês do vencimento (boleto e NF) |
| dia 13–16 | dia **1** |
| dia 17–22 | dia **8** |
| dia 23–30 | dia **15** |
| dia **31** | **precisa de revisão** (sem lote confirmado) |

- **Mês curto** (ex.: dia 30 em fevereiro): precisa de revisão; o vencimento do contrato **não** é trocado em silêncio.
- **Feriado em dia útil** na data de emissão: precisa de revisão (política pendente). **Fim de semana** só gera aviso.
- **NF fora do caso "junto do boleto":** a regra fiscal ainda está por definir, então aparece como "regra fiscal a definir".
- Itens que precisam de revisão aparecem num quadro de destaque e **não são emitidos automaticamente**.

## Vigência e renovação automática
Regra padrão: todo contrato vale **12 meses** e **renova sozinho** por mais 12 se o cliente não se manifestar. Por isso o campo *Fim da vigência* fica **em branco** na maioria dos contratos; a data final só entra quando o cliente (ou a K3G) encerra. Na tela do contrato aparece a **próxima renovação**.

## Feriados da empresa
Os feriados **nacionais** já estão no calendário. Gerente ou diretoria cadastram os **municipais e estaduais** em *Faturamento → Feriados desta empresa*; eles mudam a previsão e marcam emissões para revisão.


## Importar da planilha
Veja `importar-contratos.md`: cada linha do CSV vira um contrato em rascunho e o lote é aprovado de uma vez. O contrato pode ter a marca **Parceiro com comissão** e um percentual: veja `comissoes.md`.

## Alertas
Veja `alertas-de-contratos.md`: fim de vigência e reajuste anual aparecem num aviso no topo da lista de contratos.
