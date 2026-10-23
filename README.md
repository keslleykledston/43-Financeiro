# K3G Finance — pacote inicial para Claude Code

**Status:** especificação + instruções para construir. Não há aplicação executada ou publicada neste pacote.

## Início rápido
1. Copie o conteúdo deste pacote para a raiz de um **novo repositório Git privado** no host de desenvolvimento.
2. Leia `START_HERE.md` e `CLAUDE.md`.
3. No host, verifique ferramentas e permissões com `bash scripts/preflight.sh`.
4. Configure Claude Code e, se autorizado, Codex CLI e Lovable MCP. Não cole senhas ou tokens em prompts.
5. Abra Claude Code na raiz do repositório e envie **o texto integral** de `PROMPT_MESTRE_CLAUDE_CODE.md`.
6. O agente deve implementar e publicar a entrega E00/E01 antes de avançar para o backend financeiro.

## Documentos que devem ser mantidos
- `PROMPT_MESTRE_CLAUDE_CODE.md`: instruções executivas de desenvolvimento.
- `CLAUDE.md` e `AGENTS.md`: contexto pequeno e portátil entre modelos.
- `docs/PRD.md`: escopo, jornadas, regras confirmadas e pendências.
- `docs/ARQUITETURA.md`: desenho técnico e banco de dados.
- `docs/BACKLOG.md`: microentregas, testes e critérios de aceite.
- `docs/SEGURANCA.md`: limites e controles obrigatórios.
- `docs/API_E_INTEGRACOES.md`: contratos para conectores externos.
- `docs/UX_UI.md`: sistema visual e padrões das telas.
- `docs/DEPLOY.md`: implantação sem afetar outros sites.
- `docs/TESTES.md`: estratégia de qualidade.
- `docs/OPERACAO.md`: backup, restauração, logs, incidentes.
- `agent/memory/*`: memória operacional com fonte de verdade curta.
- `help/*`: futura central de ajuda atualizada junto às telas.

## Observações
- Os SQLs de iterações anteriores (v1/v2/v3) foram esboços **não validados**. O agente deve modelar e testar migrações novas; não importar cegamente SQL antigo.
- `financeiro.devops.k3gsolutions.com.br` é o host desejado, **não** uma evidência de DNS apontado, HTTPS configurado ou aplicação funcionando.
- Não há integração com Cora/e-NF nem conexão Lovable/Codex configurada por este pacote.
- Assuma produção bloqueada para pagamentos reais, boletos, NFs e e-mails externos até testes e autorização operacional explícita.
