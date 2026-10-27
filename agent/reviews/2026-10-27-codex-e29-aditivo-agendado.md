# Revisão Codex (somente leitura) — E29: aditivo agendado

Resultado: 0 P0, 1 P1, 1 P2.
- **P1 — cobranças já aprovadas em lote com o valor antigo.** O comportamento é o mesmo de uma alteração imediata (o lote passa a aparecer "desatualizado" e exige reabrir/revalidar, nunca muda sozinho). Mitigação: a aplicação registra no registro de atividades quantas cobranças aprovadas ficaram com o valor antigo (`approvedChargesWithOldValue`) e a ajuda explica. Não bloqueia a aplicação (os termos do contrato assinado valem; bloquear travaria o agendador).
- **P2 — base dos termos.** A aplicação grava todos os termos da versão; hoje não existe outra forma de editar termos fora do fluxo de versões (sem conflito possível). Aceito; revisitar se surgir edição direta.
Sem achado: ordem de travas contrato→versão, filtros por empresa, `contracts.approve` para cancelar, índice único parcial.
