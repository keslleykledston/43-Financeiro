# Revisão Codex — E19 área do Cora em Integrações (migração 0023)
Resultado: 2 P1, 4 P2, 2 P3 — todos tratados.
- P1 `readCoraCredentials` devolvia segredo em claro sem autorização → movida para `cora-secrets.ts` (sem import por nenhum outro arquivo; `tests/cora-secrets-guard.test.ts` falha se alguém importar e se um componente cliente tocar em módulos de credenciais). O adaptador real (E10b) será o único autorizado, rodando no servidor.
- P1 estado da Cora visível a quem não é diretoria → `hasCoraCredentials` agora exige `providers.credentials`; a tela e o item do checklist só aparecem para a diretoria.
- P2 chave curta / acoplamento com AUTH_SECRET → mínimo de 32 caracteres; chave dedicada `K3G_CREDENTIALS_KEY` em `.env.credentials` (0600, fora do Git, deny de leitura no settings), carregada só pelo `web`. Trocar a chave exige recadastro (documentado).
- P2 envelope AES-GCM sem validação de tamanho/encoding → limite de 64 KiB, base64url, IV 12 B e tag 16 B; testes.
- P2 campos de texto sem limite → `bounded()` nas actions (arquivos já limitados a 16 KiB).
- P2 interfaces permitiam cancelar boleto e extrato → `BoletoProvider.cancel` e `StatementProvider` removidos (tipos, mock e testes). Escopo agora estrutural.
- P3 erro inesperado chegava ao cliente → mensagem genérica; só o nome do erro vai para o log.
- P3 lacunas de teste → envelope malformado, permissões de `hasCoraCredentials`, guarda de importação.
Observação do Codex sobre o formulário do CRM sem `integrations.manage`: já é condicionado por `manage` na página e as actions checam permissão no servidor.
