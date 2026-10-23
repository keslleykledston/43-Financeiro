# K3G Finance — instruções portáteis (Codex e demais LLMs)

Leia `START_HERE.md`, `agent/memory/NOW.md` e o arquivo do módulo sob revisão. Não supor que já houve testes/implantação. Consulte `docs/SEGURANCA.md` e `docs/PRD.md` para decisões de segurança e domínio.

Antes de alterar código: delimite uma entrega do `docs/BACKLOG.md`. Faça testes e registre decisões em ADRs. Crie interface útil desde o começo. Não introduza funcionalidades não solicitadas que aumentem manutenção. Documente UX em `help/`. Nunca exponha segredos nem execute ações financeiras reais.

Revisão independente deve apontar prioridade P0/P1/P2, arquivo, linha ou caminho de reprodução, risco e sugestão de correção. Critérios prioritários: tenant isolation, permissão server-side, auth, idempotência de emissão, dado financeiro íntegro, migrações, egress e disponibilidade. Não aceite aprovação vazia.

Use `agent/memory/INDEX.md` como índice e atualize `NOW.md` após cada tarefa. `docs/PRD.md` é a definição funcional de alto nível. Contradições viram ADR, nunca solução silenciosa.
