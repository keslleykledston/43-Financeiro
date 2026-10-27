# Revisão Codex (somente leitura) — E28: 2FA (TOTP) e busca na ajuda

Escopo: `totp.ts`, `twofactor.ts`, `recovery.ts` (extração de `adminTarget`), `auth.ts`, login, Minha conta, Configurações, migração 0037, testes.
Resultado: **0 P0, 0 P1, 0 P2**. Confirmado: senha conferida antes de revelar `totp_required` (sem enumeração); trava por usuário (`2fa-login`) além do limite do login; replay/uso simultâneo barrado por atualização condicional do último passo; comparação em tempo constante; códigos de recuperação ~50 bits, só hash, consumo atômico; segredo cifrado e nunca em log/auditoria; ações usam só o usuário da sessão; remoção pelo administrador derruba sessões; `issueResetLink` mantém exatamente as mesmas verificações de autorização (comparado com HEAD).
Busca na ajuda (sem dados do usuário em arquivo/banco; slug validado) incluída no mesmo pacote; coberta por testes de unidade e e2e.
Observações aceitas: SHA-256 sem sal nos códigos de recuperação (entropia alta, uso único); sem QR code.
