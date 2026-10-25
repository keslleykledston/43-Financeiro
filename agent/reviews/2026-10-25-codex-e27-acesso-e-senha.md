# Revisão Codex — E27 acesso e senha (2026-10-25, somente leitura)

Escopo: convite com entrada direta, convites pendentes, política de senha, "esqueci minha senha", link de nova senha, e-mail do sistema, migração 0031, script de operação.

**Resultado: 0 P0, 0 P1, 5 P2 (+1 confirmação).**

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | Pedidos simultâneos podiam deixar mais de um link de redefinição válido | Corrigido: `pg_advisory_xact_lock` por usuário antes de expirar/inserir (3 pontos); teste de concorrência |
| 2 | P2 | `ops-reset-link.ts` gravava e só depois dava `chmod` (janela legível / symlink) | Corrigido: `openSync(out, "wx", 0o600)` antes de gerar o link; recusa arquivo existente; apaga arquivo vazio se falhar |
| 3 | P2 | Revogar a autorização entre a checagem e o envio ainda deixa sair 1 e-mail | Aceito e documentado (mesma janela do canário E23; só e-mails de senha/convite para a lista autorizada) |
| 4 | P2 | Limite por IP depende de `x-real-ip` confiável | Verificado: a porta do app é `127.0.0.1:3150` (só o proxy alcança) e `/etc/nginx/proxy_params` sobrescreve `X-Real-IP $remote_addr`. Limites por link e por e-mail seguem como defesa extra |
| 5 | P2 | Aceite de convite permitia tentar a senha de conta existente fora do limitador de login | Corrigido: limite por conta (`invite-acct:<email>`, 10/15 min) além de link e IP |
| 6 | conf. | Invalidação de sessões depende de toda rota protegida passar por `isSessionValid` | Confirmado: `requireContext` (usado por todas as telas e ações do app) chama `isSessionValid`; middleware só checa o cookie |

Sem achado: entropia/armazenamento/uso único do token (FOR UPDATE), escalada em `issueResetLink`, tomada de conta por convite, `signIn` sem open redirect, migração 0031 (compatível), travas do e-mail real (sem caminho SMTP fora delas). Não verificado pelo Codex: diferença de tempo no "esqueci minha senha" (mitigada com `after()`), valor real de `EMAIL_EXTERNAL_ENABLED` no servidor (conferir no deploy).
