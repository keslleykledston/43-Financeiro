# AGORA / Checkpoint
**Data:** 2026-10-23
**Estado real (verificado):** E04 (contratos + calendário + feriados) revisado pelo Codex (sem P0; P1 precisão monetária e 2 P2 corrigidos, ver agent/reviews/2026-10-23-codex-e04-contratos-calendario.md) + "Minha conta" (troca de senha, pedido do usuário antes do E05). SANDBOX PASS 117 unit/int + 44 e2e. Migrações 0010 e 0011. Decisões de provedores em ADR-014 (Cora simulada até haver credenciais; NFS-e Cora beta; WAHA; SMTP).
**Operação:** senha do admin redefinida em 2026-10-23 (arquivo privado fora do Git, auditada); usuário deve trocá-la em /conta e apagar o arquivo.
**Pendente do usuário:** refazer a sincronização do CRM em Integrações (esperado: 63 novos + 1 conflito de CNPJ duplicado).
**Próxima ação:** (1) E05 prévia + aprovação de lote; (2) E06 templates/fila (simulação); (3) E09 adapters (mocks) + agendador; (4) E10 real por provedor só com credenciais + autorização; depois E07, E08, E11, E12.
**Bloqueios:** nenhum.
**Git:** branch main; sem tag/force.
