# Revisão Codex — Corte do CRM (ADR-043, migração 0059)

Sem CRITICAL. Achados e tratamento:
- HIGH `CRM_CREATE_PATH` podia trocar o host do POST (`//outro-host`) e levar o token de escrita para fora da allowlist → CORRIGIDO: `CrmHttp.urlFor` exige caminho relativo, recusa `//`, `://`, `..`, `\\`, `?`/`#`, espaço e confere origem + prefixo do caminho base (leitura e escrita). Testes.
- MEDIUM timeout depois do POST de criação podia duplicar cliente → MITIGADO: resposta sem id é resolvida por busca de CNPJ; erro após POST espera ≥ 15 min antes de verificar de novo pelo CNPJ. Residual aceito: se o CRM demorar mais que isso para listar o recém-criado, pode haver duplicado (a equipe do CRM deve informar idempotência/409 — docs/CORTE_CRM.md item 5).
- MEDIUM CNPJ repetido no CRM podia vincular ao registro errado e alterar a situação dele → CORRIGIDO: ambiguidade vira falha («resolva lá»), sem escrita.
- MEDIUM «Tentar de novo» concorrendo com o envio → CORRIGIDO: só a tentativa que reservou a linha (mesmo nº de tentativas, ainda pendente) a conclui.
- LOW reserva de 10 min se o agendador morrer: aceito (nada se perde; só atrasa).
Verificado pelo Codex: isolamento por empresa, locks do corte, duplicidade na fila, ausência de vazamento do token, migração aditiva.
