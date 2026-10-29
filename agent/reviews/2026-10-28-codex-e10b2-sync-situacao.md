# Revisão Codex (somente leitura) — E10b-2 atualizar situação dos boletos da Cora de TESTES (2026-10-28)
Escopo: `issuance/sync.ts` (novo), `issuance/service.ts` (listagem), tela e ações de Emissões, auditoria, 3 testes de integração.
Veredito inicial: **BLOQUEIA** (1 P1). Após a correção: sem P0/P1 abertos.

| Sev. | Achado | Tratamento |
|---|---|---|
| — | Autorização `issuance.run`, escopo por empresa, só GET pelo cliente com allowlist, nenhuma baixa criada, sem vazamento de segredo, auditoria | Confirmado pelo Codex; sem ação |
| P1 | Corrida sync × cancelamento: a sync podia gravar `cancelado` e liberar outra geração (`:gN`) enquanto `cancelBoleto` ainda estava em curso | Corrigido: gravação sob a mesma trava de empresa e `FOR UPDATE` da cobrança do cancelamento; não grava se houver cancelamento `enviando/desconhecido` do mesmo boleto (teste novo) |
| P2 | Rodízio de 50 linhas pode adiar boletos | Parcial: consultas sem mudança já movem a linha para o fim (`updated_at`); linhas com FALHA agora também (evita que boletos que sempre falham travem a fila). Coluna própria dispensada (sem migração) |
