# Revisão Codex (somente leitura) — E31: regra de reajuste e silêncio de alertas

Resultado: 0 P0, 0 P1, 1 P2 (corrigido).
- **P2 — valor sugerido acima do teto do contrato** (R$ 99.999.999.999,99) era pré-preenchido. Corrigido: `suggestedCents` usa BigInt e devolve `null` acima do teto; a página avisa e não pré-preenche; teste.
Sem achado: isolamento por empresa no upsert (FK composta + checagem do contrato com `company_id`), validação de `pct`/`kind`/datas, XSS (React escapa), CHECKs, contrato encerrado fora da listagem.
