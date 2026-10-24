# Revisão Codex — E22 (conta de e-mail SMTP + contabilidade/dados fiscais), 2026-10-24

Somente leitura; sem P0/P1. Sem achado de vazamento de usuário/senha, IDOR, corrida no "em branco mantém", nem falha na migração 0026.

| # | Sev | Achado | Tratamento |
|---|-----|--------|-----------|
| 1 | P2 | Host SMTP: domínio público válido pode resolver para IP interno (SSRF/DNS rebinding) quando houver adaptador real. | ACEITO e registrado: hoje não há conexão de rede. Exigência para o adaptador (E10b): resolver A/AAAA na conexão, bloquear faixas internas, restringir egress. Backlog. |
| 2 | P2 | CNAE/CEP/IBGE "limpavam" qualquer caractere até sobrar o nº de dígitos. | CORRIGIDO: só números e pontuação comum (. - / espaço); resto é recusado. Teste. |
| 3 | P2 | Código de serviço só valida o formato. | ACEITO e registrado: validar contra a lista da prefeitura ao ligar a NFS-e; hoje o painel avisa para confirmar com o contador. Backlog. |
