# Revisão Codex (somente leitura) — D3c: carro, moto e consórcio são despesa da empresa

Escopo: `apply.ts` (reclassificação, regra por palavra inteira, status, recorrentes), `classify.ts`, `report.ts`, script ops, página, testes. Sem migração.
Resultado: 0 P0, 1 P1, 2 P2.

- **P1 — reclassificação ignora retirada de outra importação** (`reclassifyVehicleWithdrawals` carrega só a importação atual). Em produção há UMA importação; tratado como limite documentado (comentário no código: só a importação atual; as demais não são tocadas). Aceito.
- **P2 — regex não pega "MOTOS"** (plural / "RASTREAMENTO MOTOS"). Intencional: "RASTREAMENTO MOTOS" já é aba Empresa; não há "MOTOS" na Casa. Teste documenta. Aceito.
- **P2 — relatório de staging não aplicava a exceção** (totais por aba divergiam das contas). CORRIGIDO: `effectiveBlock` em `classify.ts`, usado por `suggest`, relatório e recorrentes; teste novo.
- Sem achado: concorrência (mesmo advisory lock por empresa), valores reaproveitados da retirada estornada, filtros por empresa.
- Não coberto pelo Codex (falha de leitura): `proposeRecurring`/séries, permissões, `plan.ts` — verificados por teste local (séries sem duplicar, gerente recusado).
