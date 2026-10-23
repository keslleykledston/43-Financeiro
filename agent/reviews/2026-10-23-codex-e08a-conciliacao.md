# Revisão Codex — E08a conciliação bancária (commit 7968bb0)
Somente leitura; testes não executados pelo Codex. **Sem P0.**

| # | Sev | Achado | Decisão |
|---|---|---|---|
| 1 | P1 | Por SQL direto dava para separar pagamento e vínculo (desfazer vínculo com pagamento ativo; estornar pagamento com vínculo ativo) | **Corrigido** (migração 0016, ainda não implantada): `bank_allocations_guard` só deixa desfazer o vínculo se o pagamento já estiver estornado; `payments_guard` (recriado em 0016 via `CREATE OR REPLACE`) só deixa estornar pagamento com vínculo ativo dentro do desfazer-vínculo (`k3g.bank_undo`, local à transação). Testes novos nos dois sentidos. |
| 2 | P1 | Dedup sem identificador (hash + ocorrência) não distingue "novo" de "repetido" quando a quantidade de lançamentos idênticos muda entre arquivos | **Mitigado**: a prévia sinaliza grupos ambíguos (linha e aviso) e a confirmação **exige marcar que conferiu** (`ackAmbiguous`, auditado). Com identificador do banco (OFX/Id) nunca há ambiguidade. Limitação inerente documentada: preferir OFX. |
| 3 | P2 | Sugestão "forte" usava `includes` (CPF dentro de CNPJ, número maior) | **Corrigido**: `docInText` exige fronteira de dígitos; a sugestão mostra o final do documento (`doc. …0181`). Testes. |
| 4 | P2 | Rota `modelo-csv` sem checagem `bank.read` | **Corrigido** (403 sem permissão). |
| 5 | P2 | Datas aceitavam sufixo arbitrário (`2026-10-23lixo`) | **Corrigido**: formas ISO e OFX ancoradas. Testes. |

Verificado sem problema pelo Codex: ordem de locks (transação bancária → cobrança → pagamento) sem deadlock, imutabilidade e ausência de DELETE, checksum + advisory lock em importações concorrentes, limites e binário/codificação, nome de arquivo, XSS, SQL cru por empresa, RBAC, auditoria sem descrição/nomes/valores/documentos, centavos/sinais, migração 0016 e regressões do E07.
