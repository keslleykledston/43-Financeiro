# Revisão Codex — N2a (prévia da DPS da NFS-e Padrão Nacional)
Data: 2026-11-04 · escopo: src/modules/nfse/*, rota/tela de prévia, migração 0054, testes (read-only).

Resultado: **0 CRITICAL, 0 HIGH, 2 MEDIUM (corrigidos)**.
- MEDIUM — `regApTribSN=1` fixo para Simples ME/EPP afirmava um enquadramento não confirmado. Correção: campo OMITIDO (o XSD o torna opcional; só vale se o ME/EPP ultrapassou sublimite) + aviso na prévia.
- MEDIUM — `pAliq`/`tpRetISSQN` saem do cadastro sem checar se o município já parametriza a alíquota. Correção: avisos na prévia (lucro presumido/real e ISS retido) pedindo conferência com o contador e na homologação (N2b).
Sem achados: isolamento por empresa (billing.read + consulta por company_id), injeção de XML (escape + normalização Latin-1), migração aditiva, fuso America/Manaus.
Observação: o XSD oficial 1.01 tem `^0{0,4}\d{1,5}$` em TSSerieDPS (^ e $ literais em XSD); o teste valida numa cópia corrigida. A confirmar na produção restrita (N2b).
