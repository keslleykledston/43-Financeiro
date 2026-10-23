# AGORA / Checkpoint
**Data:** 2026-10-22
**Estado real (verificado):** E04 (contratos locais + versões/aprovação + calendário de faturamento + feriados) implementado e commitado LOCALMENTE (e376e90), SANDBOX PASS (113 unit/int + 43 e2e); aguarda revisão Codex antes de deploy/push. Decisões de provedores (ADR-014): Cora (credenciais ainda não existem → simulado), NFS-e da Cora (beta), WhatsApp WAHA (risco de bloqueio ciente), e-mail SMTP do domínio. Integração K3G CRM: 63 clientes aguardam nova sincronização (companyRef corrigido).

**Entrega ativa:** E01 (login + shell + dashboard DEMO).
**Próxima ação:** (1) tratar achados do Codex do E04, deploy (migração 0010) + push; (2) E05 prévia+aprovação de lote; (3) E06 templates/fila (simulação); (4) E09 adapters (mocks) + agendador; (5) E10 real por provedor quando houver credenciais/autorização.
**Bloqueios:** nenhum.
**Git:** branch main, sem push/tag.
